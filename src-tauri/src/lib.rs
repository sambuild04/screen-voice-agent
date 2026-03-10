mod commands;
mod wake_word;

use commands::*;
use wake_word::*;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            create_ephemeral_key,
            capture_page,
            analyze_page,
            focus_book,
            next_page,
            prev_page,
            scroll_down,
            search_book,
            computer_use_task,
            get_config,
            transcribe_audio,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
