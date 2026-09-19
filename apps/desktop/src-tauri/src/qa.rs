use serde::Serialize;
use serde_json::{json, Value};
use std::{fs::{self, OpenOptions}, io::Write, path::{Path, PathBuf}, time::{Duration, SystemTime, UNIX_EPOCH}};
use tauri::Manager;

const HEADER: &str = "id,created_at,status,updated_at,owner,notes,report_path\n";
const MAX_BYTES: usize = 16 * 1024 * 1024;

struct QueueLock(PathBuf);

impl Drop for QueueLock {
    fn drop(&mut self) { let _ = fs::remove_dir(&self.0); }
}

fn private_dir(path: &Path) -> Result<(), String> {
    fs::create_dir_all(path).map_err(|e| e.to_string())?;
    #[cfg(unix)] {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn lock_queue(dir: &Path) -> Result<QueueLock, String> {
    let path = dir.join(".queue.lock");
    for _ in 0..40 {
        match fs::create_dir(&path) {
            Ok(()) => return Ok(QueueLock(path)),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => std::thread::sleep(Duration::from_millis(50)),
            Err(e) => return Err(e.to_string()),
        }
    }
    Err("QA queue is busy. Retry shortly; if a process crashed, ask a developer to inspect qa_bugs/.queue.lock.".into())
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut random = [0u8; 8];
    getrandom::fill(&mut random).map_err(|e| e.to_string())?;
    let temp = path.with_extension(format!("{:016x}.tmp", u64::from_le_bytes(random)));
    let result = (|| {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)] {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temp).map_err(|e| e.to_string())?;
        file.write_all(bytes).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        fs::rename(&temp, path).map_err(|e| e.to_string())
    })();
    if result.is_err() { let _ = fs::remove_file(&temp); }
    result
}

fn report_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    if let Some(path) = std::env::var_os("KAN_QA_DIR") {
        let path = PathBuf::from(path);
        if !path.is_absolute() { return Err("KAN_QA_DIR must be an absolute path".into()); }
        return Ok(path);
    }
    if cfg!(debug_assertions) {
        return Ok(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..").join("qa_bugs"));
    }
    Ok(app.path().app_local_data_dir().map_err(|e| e.to_string())?.join("qa_bugs"))
}

#[derive(Serialize)]
pub struct SavedReport { id: String, path: String }

fn save_report(dir: &Path, mut report: Value) -> Result<SavedReport, String> {
    let id = report.get("id").and_then(Value::as_str).ok_or("Missing report id")?.to_owned();
    if id.len() != 36 || !id.chars().enumerate().all(|(i, c)| {
        if [8, 13, 18, 23].contains(&i) { c == '-' } else { c.is_ascii_hexdigit() }
    }) { return Err("Invalid report id".into()); }
    if report.get("schemaVersion") != Some(&json!(1)) || !report.get("context").is_some_and(Value::is_object) {
        return Err("Invalid report schema".into());
    }
    if !report.get("description").is_some_and(|v| v.as_str().is_some_and(|s| s.chars().count() <= 10000)) {
        return Err("Description must be at most 10000 characters".into());
    }
    if serde_json::to_vec(&report).map_err(|e| e.to_string())?.len() > MAX_BYTES {
        return Err("Report exceeds the 16 MiB limit. Reduce the canvas size and retry.".into());
    }
    private_dir(dir)?;
    let dir = dir.canonicalize().map_err(|e| e.to_string())?;
    let _lock = lock_queue(&dir)?;
    let path = dir.join(format!("{id}.json"));
    let index = dir.join("bugs.csv");
    let mut csv = match fs::read_to_string(&index) {
        Ok(csv) if csv.starts_with(HEADER) => csv,
        Ok(_) => return Err("Unexpected QA CSV header; refusing to overwrite it".into()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => HEADER.to_owned(),
        Err(e) => return Err(e.to_string()),
    };
    let created_at = if path.exists() {
        let existing: Value = serde_json::from_slice(&fs::read(&path).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        existing["createdAt"].as_u64().ok_or("Invalid existing report timestamp")?
    } else {
        let now = SystemTime::now().duration_since(UNIX_EPOCH).map_err(|e| e.to_string())?.as_millis() as u64;
        report["createdAt"] = json!(now);
        report["runtime"] = json!({"version": env!("CARGO_PKG_VERSION"), "os": std::env::consts::OS, "arch": std::env::consts::ARCH, "debug": cfg!(debug_assertions)});
        atomic_write(&path, &serde_json::to_vec_pretty(&report).map_err(|e| e.to_string())?)?;
        now
    };
    if !csv.lines().any(|line| line.starts_with(&format!("{id},"))) {
        if !csv.ends_with('\n') { csv.push('\n'); }
        csv.push_str(&format!("{id},{created_at},open,{created_at},,,{id}.json\n"));
        atomic_write(&index, csv.as_bytes())?;
    }
    Ok(SavedReport { id, path: path.to_string_lossy().into_owned() })
}

#[tauri::command]
pub async fn qa_save_report(app: tauri::AppHandle, report: Value) -> Result<SavedReport, String> {
    let dir = report_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || save_report(&dir, report)).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saves_idempotently_and_recovers_unindexed_report() {
        let dir = std::env::temp_dir().join(format!("kan-qa-test-{}", SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()));
        let report = json!({"id":"12345678-1234-1234-1234-123456789abc", "schemaVersion":1, "context":{}, "description":"commas, quotes\" and\nnewlines"});
        let first = save_report(&dir, report.clone()).unwrap();
        let bytes = fs::read(&first.path).unwrap();
        save_report(&dir, report.clone()).unwrap();
        assert_eq!(fs::read(&first.path).unwrap(), bytes);
        assert_eq!(fs::read_to_string(dir.join("bugs.csv")).unwrap().lines().count(), 2);
        fs::remove_file(dir.join("bugs.csv")).unwrap();
        save_report(&dir, report).unwrap();
        assert_eq!(fs::read_to_string(dir.join("bugs.csv")).unwrap().lines().count(), 2);
        assert!(!dir.join(".queue.lock").exists());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn separates_appended_reports_when_csv_has_no_trailing_newline() {
        let dir = std::env::temp_dir().join(format!("kan-qa-newline-test-{}", SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()));
        let report = json!({"id":"12345678-1234-1234-1234-123456789abc", "schemaVersion":1, "context":{}, "description":"first"});
        save_report(&dir, report).unwrap();
        let index = dir.join("bugs.csv");
        let original = fs::read_to_string(&index).unwrap();
        fs::write(&index, original.trim_end_matches('\n')).unwrap();
        save_report(&dir, json!({"id":"12345678-1234-1234-1234-123456789def", "schemaVersion":1, "context":{}, "description":"second"})).unwrap();
        let csv = fs::read_to_string(&index).unwrap();
        assert!(csv.starts_with(&original));
        assert_eq!(csv.lines().count(), 3);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn rejects_bad_inputs_before_writing() {
        let dir = std::env::temp_dir().join("kan-qa-invalid-unused");
        assert!(save_report(&dir, json!({"id":"../escape"})).is_err());
        assert!(save_report(&dir, json!({"id":"12345678-1234-1234-1234-123456789abc", "schemaVersion":1,"context":{},"description":"x".repeat(10001)})).is_err());
        assert!(!dir.exists());
    }
}
