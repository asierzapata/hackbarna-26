mod agent;
mod agent_preferences;
mod canvas_mcp;
mod qa;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    if std::env::args().nth(1).as_deref() == Some("--canvas-mcp") {
        if canvas_mcp::serve_stdio().is_err() { std::process::exit(1); }
        return;
    }
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(agent::Agent::default())
        .manage(agent::AgentOperations::default())
        .invoke_handler(tauri::generate_handler![
            agent::agent_status,
            agent::agent_sign_in,
            agent::agent_prompt,
            agent::agent_prompt_structured,
            agent::agent_cancel,
            agent::agent_sign_out,
            agent::agent_restore,
            agent::agent_set_model,
            agent::agent_preferences,
            agent::agent_canvas_result,
            qa::qa_save_report,
        ]);

    // Automation server for e2e tests. Gated behind the `webdriver` feature so
    // it cannot reach a release bundle; see scripts/drive.mjs.
    #[cfg(feature = "webdriver")]
    let builder = builder.plugin(tauri_plugin_webdriver::init());

    builder
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
