mod agent;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(agent::Agent::default())
        .invoke_handler(tauri::generate_handler![
            agent::agent_sign_in,
            agent::agent_prompt,
            agent::agent_sign_out,
        ]);

    // Automation server for e2e tests. Gated behind the `webdriver` feature so
    // it cannot reach a release bundle; see scripts/drive.mjs.
    #[cfg(feature = "webdriver")]
    let builder = builder.plugin(tauri_plugin_webdriver::init());

    builder
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
