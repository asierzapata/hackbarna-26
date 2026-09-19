mod devin;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(devin::Devin::default())
        .invoke_handler(tauri::generate_handler![
            devin::devin_connect,
            devin::devin_login,
            devin::devin_prompt,
            devin::devin_disconnect,
        ]);

    // Automation server for e2e tests. Gated behind the `webdriver` feature so
    // it cannot reach a release bundle; see scripts/drive.mjs.
    #[cfg(feature = "webdriver")]
    let builder = builder.plugin(tauri_plugin_webdriver::init());

    builder
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
