#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod progress;
mod drafts;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
};
use tauri::{Emitter, Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
type Result<T> = std::result::Result<T, String>;
#[derive(Default)]
struct Store {
    exit_approved: bool,
    sessions: HashMap<String, Session>,
    docs: HashMap<String, Doc>,
    drafts: HashMap<String, drafts::Draft>,
}
#[derive(Clone, Serialize)]
struct Session {
    root: String,
    parent: Option<String>,
    file: Option<String>,
}
#[derive(Clone, Serialize)]
struct Doc {
    path: String,
    text: String,
    original: String,
    revision: u64,
}
#[derive(Default, Serialize, Deserialize)]
struct Config {
    version: u32,
    #[serde(default)]
    manuscript_folder: Option<String>,
    #[serde(default)]
    dashboards: HashMap<String, Option<String>>,
    #[serde(default)]
    tasks: Vec<NamedTask>,
    #[serde(default)]
    default_task: Option<String>,
}
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
struct NamedTask {
    id: String,
    label: String,
    command: String,
    #[serde(default)]
    output: String,
    #[serde(default)]
    auto_open: bool,
    #[serde(default)]
    open_external: bool,
}
fn validate_tasks(tasks: &[NamedTask]) -> Result<()> {
    let mut ids = std::collections::HashSet::new();
    let mut labels = std::collections::HashSet::new();
    for task in tasks {
        if task.id.trim().is_empty() || task.label.trim().is_empty() || task.command.trim().is_empty() {
            return Err("名前とコマンドを入力してください".into());
        }
        if !task.output.is_empty() { validate_output_path(&task.output)?; }
        if task.auto_open && task.output.is_empty() { return Err("自動で開く成果物のパスを入力してください".into()); }
        if !ids.insert(&task.id) || !labels.insert(task.label.trim()) {
            return Err("コマンドの名前とIDは重複できません".into());
        }
    }
    Ok(())
}
fn validate_output_path(path: &str) -> Result<()> {
    if path.trim().is_empty() || Path::new(path).is_absolute()
        || Path::new(path).components().any(|part| matches!(part, std::path::Component::ParentDir)) {
        return Err("成果物はプロジェクト内の相対パスで指定してください".into());
    }
    Ok(())
}
fn task_output_path(root: &str, path: &str) -> Result<PathBuf> {
    validate_output_path(path)?;
    let resolved = scoped(root, path).map_err(|e| format!("成果物が見つからないか、開けません: {path}\n{e}"))?;
    if !resolved.is_file() { return Err(format!("成果物がファイルではありません: {path}")); }
    Ok(resolved)
}
#[derive(Serialize)]
struct InternalTaskOutput { path: String, kind: String, doc: Option<Doc> }
fn load_task_output(root: &str, path: &str, docs: &mut HashMap<String, Doc>) -> Result<InternalTaskOutput> {
    let resolved = task_output_path(root, path)?;
    let key = resolved.to_string_lossy().into_owned();
    if docs.get(&key).is_some_and(|doc| doc.text != doc.original) {
        return Err("成果物に未保存の編集があります。保存または編集内容を保管してから開いてください".into());
    }
    let ext = resolved.extension().and_then(|ext| ext.to_str()).unwrap_or("").to_ascii_lowercase();
    let kind = match ext.as_str() {
        "pdf" => "pdf",
        "svg" | "png" | "jpg" | "jpeg" | "gif" | "webp" => "image",
        "html" | "htm" => "html",
        "txt" | "md" | "markdown" | "mmd" | "css" | "js" | "json" | "toml" | "csv" | "log" | "yaml" | "yml" | "xml" | "tex" => "text",
        _ => return Err("このファイル形式はアプリ内で表示できません。コマンド設定で「既定の外部アプリで開く」を選んでください".into()),
    };
    let doc = if kind == "text" { Some(read_document_from_disk(docs, &resolved, key)?) } else { None };
    let root = Path::new(root).canonicalize().map_err(|e| e.to_string())?;
    let relative = resolved.strip_prefix(root).map_err(|e| e.to_string())?.to_string_lossy().into_owned();
    Ok(InternalTaskOutput { path: relative, kind: kind.into(), doc })
}
#[tauri::command]
fn prepare_task_output(window: WebviewWindow, app: tauri::AppHandle, state: State<Mutex<Store>>, path: String) -> Result<InternalTaskOutput> {
    let root = session(&window, &state)?.root;
    let result = load_task_output(&root, &path, &mut lock(&state).docs)?;
    if let Some(doc) = &result.doc { app.emit("document-changed", doc).map_err(|e| e.to_string())?; }
    Ok(result)
}
#[tauri::command]
async fn open_task_output(window: WebviewWindow, state: State<'_, Mutex<Store>>, path: String) -> Result<()> {
    let root = session(&window, &state)?.root;
    let resolved = task_output_path(&root, &path)?;
    tauri::async_runtime::spawn_blocking(move || {
        let output = std::process::Command::new("/usr/bin/open").arg(resolved).output().map_err(|e| e.to_string())?;
        if output.status.success() { Ok(()) } else {
            Err(format!("成果物を開けませんでした: {}", String::from_utf8_lossy(&output.stderr).trim()))
        }
    }).await.map_err(|e| e.to_string())?
}
#[tauri::command]
fn get_named_tasks(window: WebviewWindow, state: State<Mutex<Store>>) -> Result<Vec<NamedTask>> {
    let s = session(&window, &state)?;
    Ok(config(&s.root)?.tasks)
}
fn default_task_id(config: &Config) -> Option<&str> {
    config.default_task.as_deref().filter(|id| config.tasks.iter().any(|task| task.id == *id))
        .or_else(|| config.tasks.first().map(|task| task.id.as_str()))
}
#[derive(Serialize)]
struct TaskSettings { tasks: Vec<NamedTask>, default_task: Option<String> }
#[tauri::command]
fn get_named_task_settings(window: WebviewWindow, state: State<Mutex<Store>>) -> Result<TaskSettings> {
    let c = config(&session(&window, &state)?.root)?;
    Ok(TaskSettings { tasks: c.tasks, default_task: c.default_task })
}
#[tauri::command]
fn save_named_tasks(window: WebviewWindow, app: tauri::AppHandle, state: State<Mutex<Store>>, tasks: Vec<NamedTask>, expected: Vec<NamedTask>, default_task: Option<String>, expected_default_task: Option<String>) -> Result<()> {
    // Serialize config changes across project windows, including dashboard changes.
    let store = lock(&state);
    let s = store.sessions.get(window.label()).ok_or("プロジェクトが未選択です")?;
    validate_tasks(&tasks)?;
    let mut c = config(&s.root)?;
    if c.tasks != expected || c.default_task != expected_default_task { return Err("登録内容が別の場所で変更されました。閉じて開き直してください".into()); }
    c.tasks = tasks;
    c.default_task = default_task;
    c.default_task = default_task_id(&c).map(str::to_owned);
    write_config(&s.root, &c)?;
    drop(store);
    refresh_task_menu(app)
}
#[tauri::command]
fn refresh_task_menu(app: tauri::AppHandle) -> Result<()> {
    use tauri::menu::{MenuItem, MenuItemKind, PredefinedMenuItem};
    let Some(MenuItemKind::Submenu(menu)) = app.menu().and_then(|m| m.get("work-menu")) else { return Ok(()); };
    let focused = app.webview_windows().into_values().find(|w| w.is_focused().unwrap_or(false));
    let project = focused.as_ref().and_then(|w| {
        let state = app.state::<Mutex<Store>>();
        let store = lock(&state);
        store.sessions.get(w.label()).map(|s| (w.label().to_string(), s.root.clone()))
    });
    let c = match &project { Some((_, root)) => config(root)?, None => Config::default() };
    let default_id = default_task_id(&c);
    let tasks = &c.tasks;
    for item in menu.items().map_err(|e| e.to_string())? {
        menu.remove(&item).map_err(|e| e.to_string())?;
    }
    if let Some((label, _)) = &project {
        for task in tasks {
            let id = format!("named-task:{}", serde_json::to_string(&(label, &task.id)).map_err(|e| e.to_string())?);
            let accelerator = if Some(task.id.as_str()) == default_id { Some("CmdOrCtrl+B") } else { None };
            let item = MenuItem::with_id(&app, id, &task.label, true, accelerator).map_err(|e| e.to_string())?;
            menu.append(&item).map_err(|e| e.to_string())?;
        }
    }
    if tasks.is_empty() {
        let text = if project.is_some() { "登録されたコマンドはありません" } else { "プロジェクトを開いてください" };
        let item = MenuItem::with_id(&app, "no-tasks", text, false, None::<&str>).map_err(|e| e.to_string())?;
        menu.append(&item).map_err(|e| e.to_string())?;
    }
    menu.append(&PredefinedMenuItem::separator(&app).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    let manage = MenuItem::with_id(&app, "manage-tasks", "コマンドを登録・編集…", project.is_some(), None::<&str>).map_err(|e| e.to_string())?;
    menu.append(&manage).map_err(|e| e.to_string())?;
    let log = MenuItem::with_id(&app, "show-task-log", "直近のコマンドログを確認…", project.is_some(), None::<&str>).map_err(|e| e.to_string())?;
    menu.append(&log).map_err(|e| e.to_string())?;
    Ok(())
}
#[derive(Serialize)]
struct TaskResult {
    success: bool,
    code: Option<i32>,
    stdout: String,
    stderr: String,
    output: String,
    auto_open: bool,
    open_external: bool,
    output_error: Option<String>,
}
fn execute_named_task(root: &str, id: &str) -> Result<TaskResult> {
    let task = config(root)?.tasks.into_iter().find(|task| task.id == id)
        .ok_or("登録されたコマンドが見つかりません")?;
    let output = std::process::Command::new("/bin/zsh")
        .args(["-lic", &task.command])
        .current_dir(root)
        .stdin(std::process::Stdio::null())
        .output().map_err(|e| format!("コマンドを実行できません: {e}"))?;
    let output_error = if task.output.is_empty() { None } else { task_output_path(root, &task.output).err() };
    Ok(TaskResult {
        output: task.output, auto_open: task.auto_open, open_external: task.open_external, output_error,
        success: output.status.success(), code: output.status.code(),
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
    })
}
fn launch_codex(window: &WebviewWindow, state: &State<Mutex<Store>>) -> Result<()> {
    let root = session(window, state)?.root;
    let output = std::process::Command::new("/usr/bin/open")
        .args(["-na", "Ghostty", "--args"])
        .arg("--window-save-state=never")
        .arg(format!("--working-directory={root}"))
        .args(["-e", "/bin/zsh", "-lic", "codex \"プロジェクトを開始します\""])
        .output().map_err(|e| format!("Ghosttyを起動できません: {e}"))?;
    if !output.status.success() {
        return Err(format!("Ghosttyを起動できません: {}", String::from_utf8_lossy(&output.stderr).trim()));
    }
    Ok(())
}
#[tauri::command]
async fn run_named_task(window: WebviewWindow, app: tauri::AppHandle, state: State<'_, Mutex<Store>>, id: String) -> Result<TaskResult> {
    let root = session(&window, &state)?.root;
    {
        let mut store = lock(&state);
        save_project_documents(&root, &mut store, |doc| {
            app.emit("document-changed", doc).map_err(|e| e.to_string())
        })?;
    }
    tauri::async_runtime::spawn_blocking(move || execute_named_task(&root, &id))
        .await.map_err(|e| e.to_string())?
}
fn save_project_documents(root: &str, store: &mut Store, mut notify: impl FnMut(&Doc) -> Result<()>) -> Result<()> {
    if store.drafts.values().any(|d| d.root == root) {
        return Err("無題の原稿があります。保存先を指定して保存するか、タブを閉じてから実行してください。".into());
    }
    let mut paths: Vec<_> = store.docs.values()
        .filter(|d| Path::new(&d.path).starts_with(root) && d.text != d.original)
        .map(|d| d.path.clone()).collect();
    paths.sort();
    for path in paths {
        let d = store.docs.get_mut(&path).unwrap();
        let saved_path = scoped(root, &path).map_err(|e| format!("保存できません: {path}\n{e}"))?;
        save_doc_to_disk(&saved_path, d).map_err(|e| format!("保存できません: {path}\n{e}"))?;
        notify(d)?;
    }
    Ok(())
}
#[tauri::command]
fn project_editor_windows(window: WebviewWindow, state: State<Mutex<Store>>) -> Result<Vec<String>> {
    let root = session(&window, &state)?.root;
    Ok(lock(&state).sessions.iter().filter(|(_, s)| s.root == root).map(|(label, _)| label.clone()).collect())
}
fn save_doc_to_disk(path: &Path, d: &mut Doc) -> Result<()> {
    let disk = fs::read_to_string(path).map_err(|e| e.to_string())?;
    if disk != d.original {
        return Err("ファイルが外部で変更されています。上書きせずに停止しました。編集内容をコピーしてからファイルを開き直してください".into());
    }
    atomic_write(path, d.text.as_bytes())?;
    d.original = d.text.clone();
    Ok(())
}
#[derive(Serialize)]
struct Entry {
    name: String,
    path: String,
    directory: bool,
    size: u64,
}
const HISTORY_LIMIT: usize = 20;
#[derive(Default, Serialize, Deserialize)]
struct HistoryFile {
    projects: Vec<String>,
}
#[derive(Default)]
struct HistoryStore {
    file: Option<PathBuf>,
    error: Option<String>,
    history: HistoryFile,
}
#[derive(Serialize)]
struct RecentProject {
    root: String,
    name: String,
    available: bool,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum TabKind { Files, Html, Text, Image, Pdf }
#[derive(Clone, Serialize, Deserialize)]
struct SavedTab { kind: TabKind, path: String, title: String }
#[derive(Clone, Default, Serialize, Deserialize)]
struct TabState { tabs: Vec<SavedTab>, active: Option<usize> }
#[derive(Clone, Serialize, Deserialize)]
struct SavedWindow { root: String, state: TabState }
#[derive(Clone, Serialize, Deserialize)]
struct WorkspaceFile {
    version: u32,
    projects: HashMap<String, TabState>,
    windows: Vec<SavedWindow>,
}
impl Default for WorkspaceFile {
    fn default() -> Self { Self { version: 1, projects: HashMap::new(), windows: Vec::new() } }
}
#[derive(Default)]
struct WorkspaceStore {
    file: Option<PathBuf>,
    error: Option<String>,
    saved: WorkspaceFile,
    live: HashMap<String, TabState>,
    restored: bool,
    previous_windows: Vec<SavedWindow>,
}
fn persist_workspace(workspace: &mut WorkspaceStore, sessions: &HashMap<String, Session>) -> Result<()> {
    if let Some(error) = &workspace.error { return Err(error.clone()); }
    let mut saved = workspace.saved.clone();
    let mut labels: Vec<_> = sessions.iter().filter(|(_, s)| s.parent.is_none()).collect();
    labels.sort_by_key(|(label, _)| *label);
    saved.windows = labels.into_iter().map(|(label, session)| SavedWindow {
        root: session.root.clone(),
        state: workspace.live.get(label).cloned()
            .or_else(|| saved.projects.get(&session.root).cloned()).unwrap_or_default(),
    }).collect();
    atomic_write(workspace.file.as_ref().ok_or("作業状態の保存先が未設定です")?,
        &serde_json::to_vec_pretty(&saved).map_err(|e| e.to_string())?)?;
    workspace.saved = saved;
    Ok(())
}
#[tauri::command]
fn validate_saved_tab(window: WebviewWindow, state: State<Mutex<Store>>, tab: SavedTab) -> Result<()> {
    let s = session(&window, &state)?;
    let path = scoped(&s.root, &tab.path)?;
    let valid = match tab.kind {
        TabKind::Files => path.is_dir(),
        TabKind::Text => path.is_file(),
        TabKind::Pdf => path.is_file() && path.extension().and_then(|e| e.to_str()).is_some_and(|ext| ext.eq_ignore_ascii_case("pdf")),
        TabKind::Image => path.is_file() && path.extension().and_then(|e| e.to_str()).is_some_and(|ext|
            matches!(ext.to_ascii_lowercase().as_str(), "svg" | "png" | "jpg" | "jpeg" | "gif" | "webp")),
        TabKind::Html => path.is_file() && matches!(path.extension().and_then(|e| e.to_str()), Some("html" | "htm")),
    };
    if valid { Ok(()) } else { Err("タブの対象が見つかりません".into()) }
}
#[tauri::command]
fn get_tab_state(window: WebviewWindow, state: State<Mutex<Store>>, workspace: State<Mutex<WorkspaceStore>>) -> Result<Option<TabState>> {
    let s = session(&window, &state)?;
    let workspace = workspace.lock().unwrap();
    if let Some(error) = &workspace.error { return Err(error.clone()); }
    Ok(workspace.live.get(window.label()).or_else(|| workspace.saved.projects.get(&s.root)).cloned())
}
#[tauri::command]
fn save_tab_state(window: WebviewWindow, state: State<Mutex<Store>>, workspace: State<Mutex<WorkspaceStore>>, tabs: TabState) -> Result<()> {
    let store = lock(&state);
    let s = store.sessions.get(window.label()).ok_or("プロジェクトが未選択です")?;
    if s.parent.is_some() { return Ok(()); }
    // Only relative paths are retained; existence is checked when restoring.
    for tab in &tabs.tabs {
        if Path::new(&tab.path).is_absolute() || Path::new(&tab.path).components().any(|p| matches!(p, std::path::Component::ParentDir)) {
            return Err("タブのパスが不正です".into());
        }
    }
    let mut workspace = workspace.lock().unwrap();
    workspace.live.insert(window.label().into(), tabs.clone());
    workspace.saved.projects.insert(s.root.clone(), tabs);
    persist_workspace(&mut workspace, &store.sessions)
}
#[tauri::command]
fn can_resume_workspace(workspace: State<Mutex<WorkspaceStore>>) -> bool {
    let workspace = workspace.lock().unwrap();
    !workspace.restored && !workspace.previous_windows.is_empty() && workspace.error.is_none()
}
#[tauri::command]
fn open_welcome(app: tauri::AppHandle, state: State<Mutex<Store>>) -> Result<()> {
    let store = lock(&state);
    if let Some(window) = app.webview_windows().values().find(|w| !store.sessions.contains_key(w.label())) {
        window.show().map_err(|e| e.to_string())?;
        return window.set_focus().map_err(|e| e.to_string());
    }
    drop(store);
    new_welcome(app)
}
#[tauri::command]
fn new_welcome(app: tauri::AppHandle) -> Result<()> {
    let label = format!("welcome-{}", NEXT.fetch_add(1, Ordering::Relaxed));
    WebviewWindowBuilder::new(&app, &label, WebviewUrl::App("index.html".into()))
                .disable_drag_drop_handler()
        .title("Writing Room").inner_size(1120., 780.).build().map_err(|e| e.to_string())?;
    Ok(())
}
#[tauri::command]
fn restore_workspace(window: WebviewWindow, app: tauri::AppHandle, state: State<Mutex<Store>>, workspace: State<Mutex<WorkspaceStore>>) -> Result<Vec<String>> {
    let mut store = lock(&state);
    let mut workspace = workspace.lock().unwrap();
    if workspace.restored { return Ok(Vec::new()); }
    workspace.restored = true;
    if let Some(error) = &workspace.error { return Err(error.clone()); }
    let mut failed = Vec::new();
    let existing_roots: std::collections::HashSet<_> = store.sessions.values()
        .filter(|s| s.parent.is_none()).map(|s| s.root.clone()).collect();
    for saved in workspace.previous_windows.clone() {
        if existing_roots.contains(&saved.root) {
            if let Some((label, _)) = store.sessions.iter().find(|(_, s)| s.parent.is_none() && s.root == saved.root) {
                if let Some(existing) = app.get_webview_window(label) { let _ = existing.set_focus(); }
            }
            continue;
        }
        if !Path::new(&saved.root).is_dir() || config(&saved.root).is_err() {
            failed.push(saved.root); continue;
        }
        let label = if !store.sessions.contains_key(window.label()) { window.label().into() }
            else { format!("project-{}", NEXT.fetch_add(1, Ordering::Relaxed)) };
        store.sessions.insert(label.clone(), Session { root: saved.root.clone(), parent: None, file: None });
        workspace.live.insert(label.clone(), saved.state);
        if label != window.label() {
            if WebviewWindowBuilder::new(&app, &label, WebviewUrl::App("index.html".into()))
                .disable_drag_drop_handler()
                .inner_size(1120., 780.).build().is_err() {
                store.sessions.remove(&label);
                workspace.live.remove(&label);
                failed.push(saved.root);
            }
        }
    }
    Ok(failed)
}
fn remember(history: &mut HistoryFile, root: String) {
    history.projects.retain(|path| path != &root);
    history.projects.insert(0, root);
    history.projects.truncate(HISTORY_LIMIT);
}
fn refresh_recent_menu(app: &tauri::AppHandle, projects: &[String]) -> Result<()> {
    use tauri::menu::{MenuItem, MenuItemKind};
    let Some(MenuItemKind::Submenu(menu)) =
        app.menu()
            .and_then(|m| m.get("file-menu"))
            .and_then(|m| match m {
                MenuItemKind::Submenu(menu) => menu.get("recent-projects"),
                _ => None,
            })
    else {
        return Ok(());
    };
    for item in menu.items().map_err(|e| e.to_string())? {
        menu.remove(&item).map_err(|e| e.to_string())?;
    }
    if projects.is_empty() {
        let item = MenuItem::with_id(app, "recent-empty", "履歴はありません", false, None::<&str>)
            .map_err(|e| e.to_string())?;
        menu.append(&item).map_err(|e| e.to_string())?;
    }
    for (index, root) in projects.iter().enumerate() {
        let path = Path::new(root);
        let name = path.file_name().unwrap_or_default().to_string_lossy();
        let label = format!(
            "{}{} — {}",
            name,
            if path.is_dir() {
                ""
            } else {
                "（見つかりません）"
            },
            path.parent().unwrap_or(path).display()
        );
        let item = MenuItem::with_id(
            app,
            format!("recent-project-{index}"),
            label,
            true,
            None::<&str>,
        )
        .map_err(|e| e.to_string())?;
        menu.append(&item).map_err(|e| e.to_string())?;
    }
    Ok(())
}
fn persist_history(
    app: &tauri::AppHandle,
    store: &mut HistoryStore,
    history: HistoryFile,
) -> Result<()> {
    if let Some(error) = &store.error {
        return Err(error.clone());
    }
    let file = store.file.as_ref().ok_or("履歴の保存先が未設定です")?;
    atomic_write(
        file,
        &serde_json::to_vec_pretty(&history).map_err(|e| e.to_string())?,
    )?;
    store.history = history;
    refresh_recent_menu(app, &store.history.projects)?;
    app.emit("history-changed", ()).map_err(|e| e.to_string())
}
#[tauri::command]
fn recent_projects(state: State<Mutex<HistoryStore>>) -> Result<Vec<RecentProject>> {
    let store = state.lock().unwrap();
    if let Some(error) = &store.error {
        return Err(error.clone());
    }
    Ok(store
        .history
        .projects
        .iter()
        .map(|root| RecentProject {
            root: root.clone(),
            name: Path::new(root)
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned(),
            available: Path::new(root).is_dir(),
        })
        .collect())
}
#[tauri::command]
fn forget_project(
    app: tauri::AppHandle,
    state: State<Mutex<HistoryStore>>,
    root: String,
) -> Result<()> {
    let mut store = state.lock().unwrap();
    let mut history = HistoryFile {
        projects: store.history.projects.clone(),
    };
    history.projects.retain(|p| p != &root);
    persist_history(&app, &mut store, history)
}
static NEXT: AtomicU64 = AtomicU64::new(1);
fn lock(state: &Mutex<Store>) -> std::sync::MutexGuard<'_, Store> {
    state.lock().unwrap()
}
fn scoped(root: &str, relative: &str) -> Result<PathBuf> {
    let root = Path::new(root).canonicalize().map_err(|e| e.to_string())?;
    let path = root
        .join(relative)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    if !path.starts_with(&root) {
        return Err("プロジェクト外のファイルにはアクセスできません".into());
    }
    Ok(path)
}
fn session(window: &WebviewWindow, state: &Mutex<Store>) -> Result<Session> {
    lock(state)
        .sessions
        .get(window.label())
        .cloned()
        .ok_or("プロジェクトが未選択です".into())
}
fn config(root: &str) -> Result<Config> {
    let p = Path::new(root).join(".writingroom.json");
    if !p.exists() {
        return Ok(Config {
            version: 1,
            ..Default::default()
        });
    }
    serde_json::from_str(&fs::read_to_string(p).map_err(|e| e.to_string())?)
        .map_err(|e| format!("設定ファイルを読み込めません: {e}"))
}
fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
    use std::io::Write;
    let temp = path.with_file_name(format!(
        ".writingroom-save-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    let result = (|| -> Result<()> {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)
            .map_err(|e| e.to_string())?;
        if let Ok(metadata) = fs::metadata(path) {
            file.set_permissions(metadata.permissions())
                .map_err(|e| e.to_string())?;
        }
        file.write_all(bytes).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        fs::rename(&temp, path).map_err(|e| e.to_string())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temp);
    }
    result
}
fn write_config(root: &str, c: &Config) -> Result<()> {
    atomic_write(
        &Path::new(root).join(".writingroom.json"),
        serde_json::to_string_pretty(c).unwrap().as_bytes(),
    )
}
#[tauri::command]
fn get_session(window: WebviewWindow, state: State<Mutex<Store>>) -> Option<Session> {
    lock(&state).sessions.get(window.label()).cloned()
}
#[tauri::command]
fn open_project(
    window: WebviewWindow,
    app: tauri::AppHandle,
    state: State<Mutex<Store>>,
    root: String,
    new_window: Option<bool>,
) -> Result<String> {
    let p = Path::new(&root)
        .canonicalize()
        .map_err(|e| format!("プロジェクトのフォルダを開けません: {root}\n{e}"))?;
    if !p.is_dir() {
        return Err("フォルダを選んでください".into());
    }
    let root = p.to_string_lossy().into_owned();
    let c = config(&root)?;
    write_config(&root, &c)?;
    let label = if new_window.unwrap_or(false) || lock(&state).sessions.contains_key(window.label())
    {
        format!("project-{}", NEXT.fetch_add(1, Ordering::Relaxed))
    } else {
        window.label().into()
    };
    lock(&state).sessions.insert(
        label.clone(),
        Session {
            root: root.clone(),
            parent: None,
            file: None,
        },
    );
    if label != window.label() {
        if let Err(e) =
            WebviewWindowBuilder::new(&app, &label, WebviewUrl::App("index.html".into()))
                .disable_drag_drop_handler()
                .title(p.file_name().unwrap_or_default().to_string_lossy())
                .inner_size(1120., 780.)
                .build()
        {
            lock(&state).sessions.remove(&label);
            return Err(e.to_string());
        }
    }
    let history_state = app.state::<Mutex<HistoryStore>>();
    let mut store = history_state.lock().unwrap();
    let mut history = HistoryFile {
        projects: store.history.projects.clone(),
    };
    remember(&mut history, root);
    if let Err(error) = persist_history(&app, &mut store, history) {
        let _ = window.emit("history-error", error);
    }
    Ok(label)
}
#[tauri::command]
fn get_manuscript_folder(window: WebviewWindow, state: State<Mutex<Store>>) -> Result<String> {
    let root = session(&window, &state)?.root;
    Ok(config(&root)?.manuscript_folder.unwrap_or_else(|| "Drafts".into()))
}
#[tauri::command]
fn list_files(
    window: WebviewWindow,
    state: State<Mutex<Store>>,
    folder: String,
) -> Result<Vec<Entry>> {
    let s = session(&window, &state)?;
    let dir = scoped(&s.root, &folder)?;
    let mut entries = vec![];
    for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
        let e = entry.map_err(|e| e.to_string())?;
        let name = e.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        let Ok(path) = e.path().canonicalize() else {
            continue;
        };
        if !path.starts_with(&s.root) {
            continue;
        }
        let m = fs::metadata(&path).map_err(|e| e.to_string())?;
        entries.push(Entry {
            name,
            path: e
                .path()
                .strip_prefix(&s.root)
                .unwrap()
                .to_string_lossy()
                .into_owned(),
            directory: m.is_dir(),
            size: m.len(),
        });
    }
    entries.sort_by(|a, b| {
        b.directory
            .cmp(&a.directory)
            .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(entries)
}
#[tauri::command]
fn dashboard(
    window: WebviewWindow,
    state: State<Mutex<Store>>,
    folder: String,
    selection: Option<String>,
    disable: bool,
    create: bool,
) -> Result<Option<String>> {
    let s = session(&window, &state)?;
    let dir = scoped(&s.root, &folder)?;
    let mut c = config(&s.root)?;
    if disable {
        c.dashboards.insert(folder.clone(), None);
        write_config(&s.root, &c)?;
        return Ok(None);
    }
    if create {
        let p = dir.join("index.html");
        let mut f = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&p)
            .map_err(|e| e.to_string())?;
        use std::io::Write;
        f.write_all(include_bytes!("../../dashboard.html"))
            .map_err(|e| e.to_string())?;
        c.dashboards
            .insert(folder.clone(), Some("index.html".into()));
        write_config(&s.root, &c)?;
    }
    if let Some(name) = selection {
        let path = scoped(&s.root, &format!("{folder}/{name}").trim_start_matches('/'))?;
        if path.parent() != Some(dir.as_path())
            || !matches!(
                path.extension().and_then(|s| s.to_str()),
                Some("html" | "htm")
            )
        {
            return Err("このフォルダのHTMLを選択してください".into());
        }
        c.dashboards.insert(folder.clone(), Some(name));
        write_config(&s.root, &c)?;
    }
    let choice = match c.dashboards.get(&folder) {
        Some(v) => v.clone(),
        None => {
            if dir.join("index.html").is_file() {
                Some("index.html".into())
            } else {
                let mut html: Vec<_> = fs::read_dir(&dir)
                    .map_err(|e| e.to_string())?
                    .flatten()
                    .filter_map(|e| {
                        let p = e.path();
                        if p.is_file()
                            && matches!(
                                p.extension().and_then(|s| s.to_str()),
                                Some("html" | "htm")
                            )
                        {
                            Some(e.file_name().to_string_lossy().into_owned())
                        } else {
                            None
                        }
                    })
                    .collect();
                html.sort();
                html.into_iter().next()
            }
        }
    };
    Ok(choice.filter(|name| dir.join(name).is_file()).map(|name| {
        if folder.is_empty() {
            name
        } else {
            format!("{folder}/{name}")
        }
    }))
}
#[tauri::command]
fn dashboard_disabled(
    window: WebviewWindow,
    state: State<Mutex<Store>>,
    folder: String,
) -> Result<bool> {
    let s = session(&window, &state)?;
    Ok(matches!(
        config(&s.root)?.dashboards.get(&folder),
        Some(None)
    ))
}
#[tauri::command]
fn create_numbered_document(window: WebviewWindow, state: State<Mutex<Store>>, path: String) -> Result<()> {
    let s = session(&window, &state)?;
    create_empty_document(&s.root, &path)
}
fn create_empty_document(root: &str, relative: &str) -> Result<()> {
    let path = Path::new(relative);
    let name = path.file_name().ok_or("ファイル名がありません")?;
    let parent = scoped(root, path.parent().and_then(|p| p.to_str()).unwrap_or(""))?;
    let target = parent.join(name);
    // Never follow or overwrite an entry created while the confirmation was open.
    match fs::OpenOptions::new().write(true).create_new(true).open(&target) {
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            let existing = scoped(root, relative)?;
            if existing.is_file() { Ok(()) } else { Err("同名のフォルダが存在します".into()) }
        }
        Err(error) => Err(error.to_string()),
    }
}
#[tauri::command]
fn read_document(window: WebviewWindow, app: tauri::AppHandle, state: State<Mutex<Store>>, path: String) -> Result<Doc> {
    let s = session(&window, &state)?;
    let p = scoped(&s.root, &path)?;
    let key = p.to_string_lossy().into_owned();
    let mut store = lock(&state);
    let d = read_document_from_disk(&mut store.docs, &p, key)?;
    app.emit("document-changed", &d).map_err(|e| e.to_string())?;
    Ok(d)
}
fn read_document_from_disk(docs: &mut HashMap<String, Doc>, p: &Path, key: String) -> Result<Doc> {
    if let Some(d) = docs.get(&key) {
        if d.text != d.original {
            return Ok(d.clone());
        }
    }
    if fs::metadata(&p).map_err(|e| e.to_string())?.len() > 10 * 1024 * 1024 {
        return Err("編集できるファイルは10MBまでです".into());
    }
    let text = fs::read_to_string(p).map_err(|e| format!("UTF-8テキストを読み込めません: {e}"))?;
    let d = Doc {
        path: key.clone(),
        original: text.clone(),
        text,
        revision: docs.get(&key).map_or(0, |d| d.revision + 1),
    };
    docs.insert(key, d.clone());
    Ok(d)
}
#[tauri::command]
fn update_document(
    window: WebviewWindow,
    app: tauri::AppHandle,
    state: State<Mutex<Store>>,
    path: String,
    text: String,
    revision: u64,
) -> Result<Doc> {
    let s = session(&window, &state)?;
    let key = scoped(&s.root, &path)?.to_string_lossy().into_owned();
    let mut store = lock(&state);
    let d = store
        .docs
        .get_mut(&key)
        .ok_or("ファイルが開かれていません")?;
    if d.revision != revision {
        return Err("別のウィンドウで更新されました。最新の内容を確認してください".into());
    }
    d.text = text;
    d.revision += 1;
    let result = d.clone();
    app.emit("document-changed", &result)
        .map_err(|e| e.to_string())?;
    Ok(result)
}
#[tauri::command]
fn save_document(
    window: WebviewWindow,
    app: tauri::AppHandle,
    state: State<Mutex<Store>>,
    path: String,
) -> Result<Doc> {
    let s = session(&window, &state)?;
    let p = scoped(&s.root, &path)?;
    let mut store = lock(&state);
    let d = store
        .docs
        .get_mut(&p.to_string_lossy().into_owned())
        .ok_or("ファイルが開かれていません")?;
    save_doc_to_disk(&p, d)?;
    let result = d.clone();
    app.emit("document-changed", &result)
        .map_err(|e| e.to_string())?;
    Ok(result)
}
#[tauri::command]
fn open_child(
    window: WebviewWindow,
    app: tauri::AppHandle,
    state: State<Mutex<Store>>,
    path: String,
) -> Result<()> {
    let mut s = session(&window, &state)?;
    scoped(&s.root, &path)?;
    let parent = s.parent.clone().unwrap_or_else(|| window.label().into());
    s.parent = Some(parent.clone());
    s.file = Some(path.clone());
    let label = format!("editor-{}", NEXT.fetch_add(1, Ordering::Relaxed));
    lock(&state).sessions.insert(label.clone(), s);
    let owner = app
        .get_webview_window(&parent)
        .ok_or("親ウィンドウが見つかりません")?;
    let result = WebviewWindowBuilder::new(&app, &label, WebviewUrl::App("index.html".into()))
                .disable_drag_drop_handler()
        .title(&path)
        .inner_size(800., 680.)
        .parent(&owner)
        .map_err(|e| e.to_string())?
        .build();
    if let Err(e) = result {
        lock(&state).sessions.remove(&label);
        return Err(e.to_string());
    }
    Ok(())
}
#[tauri::command]
fn dirty_project(window: WebviewWindow, state: State<Mutex<Store>>) -> Result<Vec<String>> {
    let s = session(&window, &state)?;
    let store = lock(&state);
    Ok(store.docs
        .values()
        .filter(|d| Path::new(&d.path).starts_with(&s.root) && d.text != d.original)
        .map(|d| d.path.clone())
        .chain(store.drafts.values().filter(|d| d.root == s.root).map(|d| d.title.clone()))
        .collect())
}
#[tauri::command]
fn close_window(
    window: WebviewWindow,
    app: tauri::AppHandle,
    state: State<Mutex<Store>>,
) -> Result<()> {
    let mut store = lock(&state);
    // Persist the remaining windows before destroying this one. Project tab
    // history is retained even when its window is explicitly closed.
    if store.sessions.contains_key(window.label()) {
        let workspace_state = app.state::<Mutex<WorkspaceStore>>();
        let mut workspace = workspace_state.lock().unwrap();
        let mut remaining = store.sessions.clone();
        remaining.remove(window.label());
        if workspace.error.is_none() { persist_workspace(&mut workspace, &remaining)?; }
        workspace.live.remove(window.label());
    }
    let s = store.sessions.remove(window.label());
    if s.as_ref().is_some_and(|s| s.parent.is_none()) {
        let children: Vec<_> = store
            .sessions
            .iter()
            .filter(|(_, s)| s.parent.as_deref() == Some(window.label()))
            .map(|(k, _)| k.clone())
            .collect();
        for label in children {
            store.sessions.remove(&label);
            store.drafts.retain(|_, d| d.owner != label);
            if let Some(w) = app.get_webview_window(&label) {
                w.destroy().map_err(|e| e.to_string())?
            }
        }
        if let Some(s) = s {
            if !store.sessions.values().any(|other| other.root == s.root) {
                store.docs.retain(|p, _| !Path::new(p).starts_with(&s.root));
            }
        }
    }
    store.drafts.retain(|_, d| d.owner != window.label());
    drop(store);
    window.destroy().map_err(|e| e.to_string())
}
#[tauri::command]
fn dirty_all(state: State<Mutex<Store>>) -> Vec<String> {
    let store = lock(&state);
    store.docs.values().filter(|d| d.text != d.original).map(|d| d.path.clone())
        .chain(store.drafts.values().map(|d| d.title.clone())).collect()
}
#[tauri::command]
fn quit_app(app: tauri::AppHandle, state: State<Mutex<Store>>) {
    lock(&state).exit_approved = true;
    app.exit(0);
}
#[tauri::command]
async fn reveal_in_finder(window: WebviewWindow, state: State<'_, Mutex<Store>>, path: String) -> Result<()> {
    let s = session(&window, &state)?;
    let path = scoped(&s.root, &path)?;
    #[cfg(target_os = "macos")]
    {
        tauri::async_runtime::spawn_blocking(move || {
            let output = std::process::Command::new("/usr/bin/open")
                .arg("-R").arg(path).output().map_err(|e| e.to_string())?;
            if output.status.success() { Ok(()) } else {
                Err(format!("Finderで開けませんでした: {}", String::from_utf8_lossy(&output.stderr).trim()))
            }
        }).await.map_err(|e| e.to_string())?
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = path;
        Err("Finderで開く機能はmacOSで対応しています。".into())
    }
}
fn external_url(url: &str) -> Result<tauri::Url> {
    let parsed = tauri::Url::parse(url).map_err(|e| e.to_string())?;
    if matches!(parsed.scheme(), "javascript" | "data" | "file" | "blob" | "about" | "project" | "tauri" | "asset" | "ipc")
        || parsed.host_str() == Some("project.localhost")
    {
        return Err("このURLは外部アプリで開けません。".into());
    }
    Ok(parsed)
}
#[tauri::command]
async fn open_external_url(url: String) -> Result<()> {
    let parsed = external_url(&url)?;
    #[cfg(target_os = "macos")]
    {
        tauri::async_runtime::spawn_blocking(move || {
            let output = std::process::Command::new("/usr/bin/open")
                .arg(parsed.as_str()).output().map_err(|e| e.to_string())?;
            if output.status.success() { Ok(()) } else {
                Err(format!("外部アプリを開けませんでした: {}", String::from_utf8_lossy(&output.stderr).trim()))
            }
        }).await.map_err(|e| e.to_string())?
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = parsed;
        Err("外部URLの起動はmacOSで対応しています。".into())
    }
}
#[derive(Serialize, Deserialize)]
struct EditorPreferences { font_size: u8 }
impl Default for EditorPreferences {
    fn default() -> Self { Self { font_size: 16 } }
}
#[derive(Default)]
struct EditorPreferencesStore {
    value: EditorPreferences,
    file: Option<PathBuf>,
    error: Option<String>,
}
fn adjusted_font_size(current: u8, action: &str) -> Result<u8> {
    match action {
        "increase" => Ok(current.saturating_add(1).clamp(12, 32)),
        "decrease" => Ok(current.saturating_sub(1).clamp(12, 32)),
        "reset" => Ok(16),
        _ => Err("文字サイズの操作が不正です".into()),
    }
}
#[tauri::command]
fn sync_typewriter_menu(window: WebviewWindow, app: tauri::AppHandle, enabled: bool) -> Result<()> {
    if !window.is_focused().map_err(|e| e.to_string())? { return Ok(()); }
    if let Some(tauri::menu::MenuItemKind::Check(item)) = app.menu().and_then(|menu| menu.get("toggle-typewriter-mode")) {
        item.set_checked(enabled).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn get_editor_font_size(state: State<Mutex<EditorPreferencesStore>>) -> Result<u8> {
    let store = state.lock().unwrap();
    if let Some(error) = &store.error { return Err(error.clone()); }
    Ok(store.value.font_size)
}
#[tauri::command]
fn change_editor_font_size(app: tauri::AppHandle, state: State<Mutex<EditorPreferencesStore>>, action: String) -> Result<u8> {
    let mut store = state.lock().unwrap();
    if let Some(error) = &store.error { return Err(error.clone()); }
    let font_size = adjusted_font_size(store.value.font_size, &action)?;
    let value = EditorPreferences { font_size };
    let file = store.file.as_ref().ok_or("表示設定の保存先がありません")?;
    atomic_write(file, &serde_json::to_vec_pretty(&value).map_err(|e| e.to_string())?)?;
    store.value = value;
    app.emit("editor-font-size-changed", font_size).map_err(|e| e.to_string())?;
    Ok(font_size)
}
fn main() {
    let app = tauri::Builder::default()
        .manage(Mutex::new(Store::default()))
        .manage(Mutex::new(EditorPreferencesStore::default()))
        .manage(Mutex::new(HistoryStore::default()))
        .manage(Mutex::new(WorkspaceStore::default()))
        .setup(|app| {
            {
                let state = app.state::<Mutex<EditorPreferencesStore>>();
                let mut store = state.lock().unwrap();
                let loaded = (|| -> Result<(PathBuf, EditorPreferences)> {
                    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
                    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
                    let file = dir.join("editor-preferences.json");
                    let mut value: EditorPreferences = if file.exists() {
                        serde_json::from_slice(&fs::read(&file).map_err(|e| e.to_string())?)
                            .map_err(|e| format!("表示設定を読み込めません: {e}"))?
                    } else { EditorPreferences::default() };
                    value.font_size = value.font_size.clamp(12, 32);
                    Ok((file, value))
                })();
                match loaded {
                    Ok((file, value)) => { store.file = Some(file); store.value = value; }
                    Err(error) => store.error = Some(error),
                }
            }
            {
                let state = app.state::<Mutex<WorkspaceStore>>();
                let mut workspace = state.lock().unwrap();
                let loaded = (|| -> Result<(PathBuf, WorkspaceFile)> {
                    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
                    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
                    let file = dir.join("workspace-state.json");
                    let saved: WorkspaceFile = if file.exists() {
                        serde_json::from_slice(&fs::read(&file).map_err(|e| e.to_string())?)
                            .map_err(|e| format!("作業状態を読み込めません: {e}"))?
                    } else { WorkspaceFile::default() };
                    if saved.version != 1 { return Err("作業状態の形式に対応していません".into()); }
                    Ok((file, saved))
                })();
                match loaded {
                    Ok((file, saved)) => { workspace.file = Some(file); workspace.previous_windows = saved.windows.clone(); workspace.saved = saved; }
                    Err(error) => workspace.error = Some(error),
                }
            }
            let state = app.state::<Mutex<HistoryStore>>();
            let mut store = state.lock().unwrap();
            let loaded = (|| -> Result<(PathBuf,HistoryFile)> {
                let dir = app.path().app_data_dir().map_err(|e|e.to_string())?;
                fs::create_dir_all(&dir).map_err(|e|e.to_string())?;
                let file = dir.join("recent-projects.json");
                let mut history:HistoryFile = if file.exists() {
                    serde_json::from_slice(&fs::read(&file).map_err(|e|e.to_string())?).map_err(|e|format!("履歴を読み込めません: {e}"))?
                } else { HistoryFile::default() };
                let mut unique = std::collections::HashSet::new();
                history.projects.retain(|p|unique.insert(p.clone()));
                history.projects.truncate(HISTORY_LIMIT);
                Ok((file,history))
            })();
            match loaded {
                Ok((file,history)) => { store.file=Some(file); store.history=history; },
                Err(error) => store.error=Some(error)
            }
            refresh_recent_menu(app.handle(),&store.history.projects).map_err(std::io::Error::other)?;
            Ok(())
        })
        .plugin(tauri_plugin_dialog::init())
        .menu(|app| {
            use tauri::menu::{MenuBuilder, SubmenuBuilder, MenuItem, CheckMenuItem};
            let quit = MenuItem::with_id(app,"quit-confirm","Writing Roomを終了",true,Some("CmdOrCtrl+Q"))?;
            let app_menu = SubmenuBuilder::new(app,"Writing Room").item(&quit).build()?;
            let edit = SubmenuBuilder::new(app,"編集").undo().redo().separator().cut().copy().paste().select_all().build()?;
            let open_project = MenuItem::with_id(app,"open-project","プロジェクトを開く…",true,Some("CmdOrCtrl+O"))?;
            let save = MenuItem::with_id(app,"save-document","保存",true,Some("CmdOrCtrl+S"))?;
            let track = MenuItem::with_id(app,"track-document","このファイルを追跡に追加",true,None::<&str>)?;
            let progress = MenuItem::with_id(app,"record-progress","この原稿を記録…（⌘K → K）",true,None::<&str>)?;
            let new_document = MenuItem::with_id(app,"new-document","新しい原稿",true,Some("CmdOrCtrl+N"))?;
            let new_window = MenuItem::with_id(app,"new-window","新しいウィンドウ",true,Some("CmdOrCtrl+Shift+N"))?;
            let recent = SubmenuBuilder::with_id(app,"recent-projects","最近使ったプロジェクト").build()?;
            let close_tab = MenuItem::with_id(app,"close-tab","タブを閉じる",true,Some("CmdOrCtrl+W"))?;
            let close_window = MenuItem::with_id(app,"close-project-window","ウィンドウを閉じる",true,Some("CmdOrCtrl+Shift+W"))?;
            let file = SubmenuBuilder::with_id(app,"file-menu","ファイル").item(&new_document).item(&new_window).separator().item(&open_project).item(&recent).item(&save).separator().item(&close_tab).item(&close_window).build()?;
            let no_tasks = MenuItem::with_id(app,"no-tasks","プロジェクトを開いてください",false,None::<&str>)?;
            let tasks = MenuItem::with_id(app,"manage-tasks","コマンドを登録・編集…",true,None::<&str>)?;
            let task_log = MenuItem::with_id(app,"show-task-log","直近のコマンドログを確認…",false,None::<&str>)?;
            let work = SubmenuBuilder::with_id(app,"work-menu","作業").item(&no_tasks).separator().item(&tasks).item(&task_log).build()?;
            let project_progress = MenuItem::with_id(app,"record-project-progress","プロジェクトを記録…",true,None::<&str>)?;
            let document_history = MenuItem::with_id(app,"show-document-history","この原稿の履歴…（⌘K → L）",true,None::<&str>)?;
            let project_history = MenuItem::with_id(app,"show-project-history","プロジェクトの履歴…",true,None::<&str>)?;
            let history = SubmenuBuilder::with_id(app,"history-menu","履歴").item(&track).item(&progress).item(&project_progress).separator().item(&document_history).item(&project_history).build()?;
            let inspect = MenuItem::with_id(app,"toggle-devtools","開発者ツールの表示／非表示",true,Some("CmdOrCtrl+Alt+I"))?;
            let typewriter = CheckMenuItem::with_id(app,"toggle-typewriter-mode","タイプライターモード",true,false,None::<&str>)?;
            let focus = MenuItem::with_id(app,"toggle-focus-mode","全集中モード",true,Some("CmdOrCtrl+Alt+F"))?;
            let filer = MenuItem::with_id(app,"show-filer","ファイラー",true,None::<&str>)?;
            let increase = MenuItem::with_id(app,"font-increase","文字を大きくする",true,Some("CmdOrCtrl+="))?;
            let decrease = MenuItem::with_id(app,"font-decrease","文字を小さくする",true,Some("CmdOrCtrl+-"))?;
            let reset = MenuItem::with_id(app,"font-reset","文字サイズを標準に戻す",true,Some("CmdOrCtrl+0"))?;
            let previous = MenuItem::with_id(app,"numbered-previous","前の連番ファイル",true,Some("CmdOrCtrl+Alt+["))?;
            let next = MenuItem::with_id(app,"numbered-next","次の連番ファイル",true,Some("CmdOrCtrl+Alt+]"))?;
            let previous_tab = MenuItem::with_id(app,"tab-previous","前のタブ",true,Some("CmdOrCtrl+Alt+Left"))?;
            let next_tab = MenuItem::with_id(app,"tab-next","次のタブ",true,Some("CmdOrCtrl+Alt+Right"))?;
            let book_headings = MenuItem::with_id(app,"show-book-headings","全体の見出しへ移動…",true,Some("CmdOrCtrl+Alt+Shift+O"))?;
            let headings = MenuItem::with_id(app,"show-headings","見出しへ移動…",true,Some("CmdOrCtrl+Shift+O"))?;
            let close_heading = MenuItem::with_id(app,"close-heading","直近の見出しを閉じる（⌘H → P）",true,None::<&str>)?;
            let open_heading = MenuItem::with_id(app,"open-heading","直近の見出しを開く（⌘H → O）",true,None::<&str>)?;
            let navigation = SubmenuBuilder::new(app,"移動").item(&headings).item(&book_headings).item(&close_heading).item(&open_heading).separator().item(&previous_tab).item(&next_tab).separator().item(&previous).item(&next).build()?;
            let view = SubmenuBuilder::new(app,"表示").item(&filer).separator().item(&increase).item(&decrease).item(&reset).separator().item(&focus).item(&typewriter).separator().item(&inspect).build()?;
            let codex = MenuItem::with_id(app,"launch-codex","codexを起動",true,None::<&str>)?;
            let agent = SubmenuBuilder::new(app,"エージェント").item(&codex).build()?;
            MenuBuilder::new(app).items(&[&app_menu,&file,&edit,&history,&work,&agent,&view,&navigation]).build()
        })
        .on_menu_event(|app,event| {
            if event.id().as_ref() == "launch-codex" {
                if let Some(window) = app.webview_windows().into_values().find(|w| w.is_focused().unwrap_or(false)) {
                    if let Err(error) = launch_codex(&window, &app.state::<Mutex<Store>>()) {
                        let _ = window.emit("history-error", error);
                    }
                }
                return;
            }
            if let Some(encoded) = event.id().as_ref().strip_prefix("named-task:") {
                if let Ok((label, id)) = serde_json::from_str::<(String, String)>(encoded) {
                    if let Some(window) = app.get_webview_window(&label).filter(|w| w.is_focused().unwrap_or(false)) {
                        let _ = window.emit("run-task-requested", id);
                    }
                }
                return;
            }

            if event.id().as_ref() == "new-window" {
                if let Err(error) = new_welcome(app.clone()) { let _ = app.emit("history-error", error); }
            }
            if let Some(index) = event.id().as_ref().strip_prefix("recent-project-").and_then(|s|s.parse::<usize>().ok()) {
                let state = app.state::<Mutex<HistoryStore>>();
                let root = state.lock().unwrap().history.projects.get(index).cloned();
                let windows = app.webview_windows();
                let target = windows.values().find(|w|w.is_focused().unwrap_or(false)).or_else(||windows.get("main")).or_else(||windows.values().next());
                if let (Some(root),Some(window)) = (root,target) { let _ = window.emit("open-recent-requested",root); }
            }
            if event.id().as_ref() == "toggle-devtools" {
                let windows = app.webview_windows();
                let target = windows.values().find(|window|window.is_focused().unwrap_or(false))
                    .or_else(||windows.values().find(|window|window.is_devtools_open()))
                    .or_else(||windows.get("main"));
                if let Some(window) = target {
                    if window.is_devtools_open() { window.close_devtools(); } else { window.open_devtools(); }
                }
            }
            if matches!(event.id().as_ref(), "show-book-headings" | "show-filer" | "open-heading" | "close-heading" | "show-headings" | "show-task-log" | "close-tab" | "close-project-window" | "run-task" | "manage-tasks" | "open-project" | "save-document" | "new-document" | "track-document" | "record-progress" | "record-project-progress" | "show-document-history" | "show-project-history" | "toggle-typewriter-mode" | "toggle-focus-mode" | "font-increase" | "font-decrease" | "font-reset" | "numbered-previous" | "numbered-next" | "tab-previous" | "tab-next") {
                let windows = app.webview_windows();
                let target = windows.values().find(|window|window.is_focused().unwrap_or(false)).or_else(||windows.get("main")).or_else(||windows.values().next());
                if let Some(window) = target {
                    let name = match event.id().as_ref() {
                        "show-filer" => "show-filer-requested",
                        "show-book-headings" => "show-book-headings-requested",
                        "open-heading" => "open-heading-requested",
                        "close-heading" => "close-heading-requested",
                        "show-headings" => "show-headings-requested",
                        "show-task-log" => "show-task-log-requested",
                        "close-tab" => "close-tab-requested",
                        "close-project-window" => "close-window-requested",
                        "run-task" => "run-task-requested",
                        "manage-tasks" => "manage-tasks-requested",
                        "save-document" => "save-requested",
                        "new-document" => "new-document-requested",
                        "show-document-history" => "show-document-history-requested",
                        "show-project-history" => "show-project-history-requested",
                        "record-progress" => "record-progress-requested",
                        "record-project-progress" => "record-project-progress-requested",
                        "track-document" => "track-document-requested",
                        "toggle-typewriter-mode" => "typewriter-mode-requested",
                        "toggle-focus-mode" => "focus-mode-requested",
                        "font-increase" => "font-increase-requested",
                        "font-decrease" => "font-decrease-requested",
                        "font-reset" => "font-reset-requested",
                        "numbered-previous" => "numbered-previous-requested",
                        "numbered-next" => "numbered-next-requested",
                        "tab-previous" => "tab-previous-requested",
                        "tab-next" => "tab-next-requested",
                        _ => "open-project-requested",
                    };
                    let _ = window.emit(name,());
                }
            }
            if event.id().as_ref() == "quit-confirm" {
                let state = app.state::<Mutex<Store>>();
                let label = lock(&state).sessions.iter().find(|(_,s)|s.parent.is_none()).map(|(label,_)|label.clone()).or_else(||app.webview_windows().keys().next().cloned()).unwrap_or_else(||"main".into());
                let _ = app.emit_to(label,"quit-requested",());
            }
        })
        .register_uri_scheme_protocol("project", |ctx, request| {
            let app = ctx.app_handle();
            let state = app.state::<Mutex<Store>>();
            let uri = request.uri();
            let pieces: Vec<_> = uri.path().trim_start_matches('/').splitn(2, '/').collect();
            let response = (|| -> Result<Vec<u8>> {
                if pieces.len() != 2 || ctx.webview_label() != pieces[0] { return Err("Invalid project path".into()); }
                let s = lock(&state).sessions.get(pieces[0]).cloned().ok_or("Unknown project")?;
                let relative = decode(pieces[1])?;
                let p = scoped(&s.root, &relative)?;
                let bytes = fs::read(&p).map_err(|e| e.to_string())?;
                if matches!(p.extension().and_then(|e| e.to_str()), Some("html" | "htm")) {
                    let mut html = String::from_utf8(bytes).map_err(|e| e.to_string())?;
                    html.push_str(include_str!("../../src/dashboard-links.js.html"));
                    Ok(html.into_bytes())
                } else { Ok(bytes) }
            })();
            let extension = uri.path().rsplit('.').next().unwrap_or("").to_ascii_lowercase();
            let mime = match extension.as_str() {
                "html" | "htm" => "text/html; charset=utf-8",
                "css" => "text/css", "js" | "mjs" => "text/javascript",
                "svg" => "image/svg+xml", "png" => "image/png",
                "pdf" => "application/pdf",
                "jpg" | "jpeg" => "image/jpeg", "gif" => "image/gif", "webp" => "image/webp",
                "json" => "application/json", _ => "application/octet-stream"
            };
            match response {
                Ok(bytes) => tauri::http::Response::builder().header("Content-Type", mime).header("Access-Control-Allow-Origin", "*").body(bytes).unwrap(),
                Err(e) => tauri::http::Response::builder().status(404).body(e.into_bytes()).unwrap()
            }
        })
        .invoke_handler(tauri::generate_handler![sync_typewriter_menu, drafts::create_draft, drafts::update_draft, drafts::discard_draft, drafts::save_draft, new_welcome, prepare_task_output, open_task_output, get_named_task_settings, refresh_task_menu, project_editor_windows, run_named_task, get_named_tasks, save_named_tasks, progress::list_progress_history, progress::progress_history_diff, progress::preview_project_progress, progress::commit_project_progress, progress::track_document, progress::preview_progress, progress::commit_progress, get_editor_font_size, change_editor_font_size, get_session, get_manuscript_folder, open_project, recent_projects, forget_project, list_files, dashboard, dashboard_disabled, create_numbered_document, read_document, update_document, save_document, open_child, dirty_project, close_window, dirty_all, quit_app, open_external_url, reveal_in_finder, get_tab_state, save_tab_state, restore_workspace, validate_saved_tab, can_resume_workspace, open_welcome])
        .build(tauri::generate_context!()).expect("アプリを起動できません");
    app.run(|app, event| {
        if let tauri::RunEvent::ExitRequested { api, .. } = event {
            if app.webview_windows().is_empty() || lock(&app.state::<Mutex<Store>>()).exit_approved
            {
                return;
            }
            api.prevent_exit();
            let state = app.state::<Mutex<Store>>();
            let label = lock(&state)
                .sessions
                .iter()
                .find(|(_, s)| s.parent.is_none())
                .map(|(label, _)| label.clone())
                .or_else(|| app.webview_windows().keys().next().cloned())
                .unwrap_or_else(|| "main".into());
            let _ = app.emit_to(label, "quit-requested", ());
        }
    });
}
fn decode(s: &str) -> Result<String> {
    let mut bytes = Vec::new();
    let mut it = s.bytes();
    while let Some(b) = it.next() {
        if b == b'%' {
            let a = it.next().ok_or("Invalid URL")?;
            let b = it.next().ok_or("Invalid URL")?;
            let h = std::str::from_utf8(&[a, b])
                .map_err(|e| e.to_string())?
                .to_owned();
            bytes.push(u8::from_str_radix(&h, 16).map_err(|e| e.to_string())?)
        } else {
            bytes.push(b)
        }
    }
    String::from_utf8(bytes).map_err(|e| e.to_string())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn internal_outputs_reload_clean_documents_and_preserve_unsaved_edits() {
        let dir = std::env::temp_dir().join(format!("writingroom-internal-output-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
        fs::create_dir_all(&dir).unwrap();
        let root = dir.to_str().unwrap();
        let mut docs = HashMap::new();
        let file = dir.join("book.md");
        fs::write(&file, "first").unwrap();
        let first = load_task_output(root, "./book.md", &mut docs).unwrap();
        assert_eq!(first.path, "book.md");
        assert_eq!(first.kind, "text");
        let doc = first.doc.unwrap();
        fs::write(&file, "second").unwrap();
        let updated = load_task_output(root, "book.md", &mut docs).unwrap().doc.unwrap();
        assert_eq!(updated.text, "second");
        assert!(updated.revision > doc.revision);
        docs.get_mut(&doc.path).unwrap().text = "unsaved".into();
        assert!(load_task_output(root, "book.md", &mut docs).is_err());
        assert_eq!(docs[&doc.path].text, "unsaved");
        assert_eq!(fs::read_to_string(file).unwrap(), "second");
        for (name, kind) in [("book.pdf", "pdf"), ("book.html", "html"), ("cover.png", "image")] {
            fs::write(dir.join(name), "data").unwrap();
            let result = load_task_output(root, name, &mut docs).unwrap();
            assert_eq!(result.kind, kind);
            assert!(result.doc.is_none());
        }
        fs::write(dir.join("book.epub"), "data").unwrap();
        assert!(load_task_output(root, "book.epub", &mut docs).is_err());
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn task_outputs_are_optional_and_stay_inside_project() {
        let task: NamedTask = serde_json::from_str(r#"{"id":"pdf","label":"PDF","command":"make"}"#).unwrap();
        assert!(task.output.is_empty());
        assert!(!task.auto_open);
        assert!(!task.open_external);
        assert!(validate_tasks(&[NamedTask { auto_open: true, ..task.clone() }]).is_err());
        for path in ["/tmp/book.pdf", "../book.pdf", "Build/../../book.pdf"] {
            assert!(validate_tasks(&[NamedTask { output: path.into(), ..task.clone() }]).is_err());
        }
        let configured = NamedTask { output: "Build/book.pdf".into(), auto_open: true, open_external: true, ..task };
        validate_tasks(&[configured.clone()]).unwrap();
        let saved: NamedTask = serde_json::from_str(&serde_json::to_string(&configured).unwrap()).unwrap();
        assert_eq!(saved, configured);
        let dir = std::env::temp_dir().join(format!("writingroom-output-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
        let root = dir.join("project");
        fs::create_dir_all(root.join("Build")).unwrap();
        fs::write(root.join("Build/book.pdf"), "pdf").unwrap();
        let root_str = root.to_str().unwrap();
        assert!(task_output_path(root_str, "Build/book.pdf").is_ok());
        assert!(task_output_path(root_str, "missing.pdf").is_err());
        assert!(task_output_path(root_str, "Build").is_err());
        #[cfg(unix)] {
            fs::write(dir.join("outside.pdf"), "outside").unwrap();
            std::os::unix::fs::symlink(dir.join("outside.pdf"), root.join("linked.pdf")).unwrap();
            assert!(task_output_path(root_str, "linked.pdf").is_err());
        }
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn default_task_selection_falls_back_and_roundtrips() {
        let mut c: Config = serde_json::from_str(r#"{"version":1,"tasks":[{"id":"pdf","label":"PDF","command":"make pdf"}]}"#).unwrap();
        assert_eq!(default_task_id(&c), Some("pdf"));
        c.tasks.push(NamedTask { id: "html".into(), label: "HTML".into(), command: "make html".into(), ..Default::default() });
        assert_eq!(default_task_id(&c), Some("pdf"));
        c.default_task = Some("html".into());
        let saved: Config = serde_json::from_str(&serde_json::to_string(&c).unwrap()).unwrap();
        assert_eq!(default_task_id(&saved), Some("html"));
        c.tasks.pop();
        assert_eq!(default_task_id(&c), Some("pdf"));
        c.tasks.clear();
        assert_eq!(default_task_id(&c), None);
    }
    #[test]
    fn task_save_includes_shared_documents_and_stops_on_external_changes() {
        let dir = std::env::temp_dir().join(format!("writingroom-task-save-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
        fs::create_dir_all(&dir).unwrap();
        let root = dir.to_str().unwrap();
        let path = dir.join("chapter.md");
        fs::write(&path, "before").unwrap();
        let key = path.to_string_lossy().into_owned();
        let mut store = Store::default();
        store.docs.insert(key.clone(), Doc { path: key.clone(), text: "after".into(), original: "before".into(), revision: 2 });
        store.docs.insert("/unrelated/chapter.md".into(), Doc { path: "/unrelated/chapter.md".into(), text: "changed".into(), original: "old".into(), revision: 1 });
        let mut notifications = Vec::new();
        save_project_documents(root, &mut store, |d| { notifications.push(d.clone()); Ok(()) }).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "after");
        assert_eq!(notifications.len(), 1);
        assert_eq!(store.docs[&key].original, "after");
        store.docs.get_mut(&key).unwrap().text = "next".into();
        fs::write(&path, "external").unwrap();
        assert!(save_project_documents(root, &mut store, |_| Ok(())).is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "external");
        assert_eq!(store.docs[&key].original, "after");
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn named_task_execution_uses_project_directory_and_reports_failure() {
        let dir = std::env::temp_dir().join(format!("writingroom-task-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("source.txt"), "原稿").unwrap();
        let root = dir.to_str().unwrap();
        let mut c = config(root).unwrap();
        c.tasks = vec![
            NamedTask { id: "ok".into(), label: "成功".into(), command: "cat source.txt".into(), ..Default::default() },
            NamedTask { id: "fail".into(), label: "失敗".into(), command: "printf error >&2; exit 7".into(), ..Default::default() },
        ];
        write_config(root, &c).unwrap();
        let output = execute_named_task(root, "ok").unwrap();
        assert!(output.success);
        assert_eq!(output.stdout, "原稿");
        let output = execute_named_task(root, "fail").unwrap();
        assert!(!output.success);
        assert_eq!(output.code, Some(7));
        assert_eq!(output.stderr, "error");
        assert!(execute_named_task(root, "missing").is_err());
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn named_tasks_compatibility_validation_and_roundtrip() {
        let mut old: Config = serde_json::from_str(r#"{"version":1,"dashboards":{"":"index.html"}}"#).unwrap();
        assert!(old.tasks.is_empty());
        let task = NamedTask { id: "pdf".into(), label: "PDFを作る".into(), command: "make pdf".into(), ..Default::default() };
        old.tasks.push(task.clone());
        validate_tasks(&old.tasks).unwrap();
        let loaded: Config = serde_json::from_str(&serde_json::to_string(&old).unwrap()).unwrap();
        assert_eq!(loaded.tasks, vec![task.clone()]);
        assert_eq!(loaded.dashboards.get(""), Some(&Some("index.html".into())));
        assert!(validate_tasks(&[task.clone(), task.clone()]).is_err());
        assert!(validate_tasks(&[NamedTask { id: "other".into(), command: "  ".into(), ..task.clone() }]).is_err());
        assert!(validate_tasks(&[task.clone(), NamedTask { id: "other".into(), label: " PDFを作る ".into(), ..task }]).is_err());
        validate_tasks(&[]).unwrap();
    }
    #[test]
    fn numbered_creation_preserves_existing_files_and_project_boundary() {
        let dir = std::env::temp_dir().join(format!("writingroom-numbered-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
        let root = dir.join("project");
        fs::create_dir_all(root.join("draft")).unwrap();
        let root_str = root.to_str().unwrap();
        create_empty_document(root_str, "draft/chapter002.md").unwrap();
        let target = root.join("draft/chapter002.md");
        assert_eq!(fs::read_to_string(&target).unwrap(), "");
        fs::write(&target, "keep this manuscript").unwrap();
        create_empty_document(root_str, "draft/chapter002.md").unwrap();
        assert_eq!(fs::read_to_string(&target).unwrap(), "keep this manuscript");
        assert!(create_empty_document(root_str, "../chapter003.md").is_err());
        assert!(!dir.join("chapter003.md").exists());
        fs::create_dir(root.join("chapter004.md")).unwrap();
        assert!(create_empty_document(root_str, "chapter004.md").is_err());
        #[cfg(unix)] {
            std::os::unix::fs::symlink(&dir, root.join("outside")).unwrap();
            assert!(create_empty_document(root_str, "outside/chapter005.md").is_err());
        }
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn reopening_document_reads_disk_unless_unsaved() {
        let dir = std::env::temp_dir().join(format!("writingroom-reopen-{}", NEXT.fetch_add(1, Ordering::Relaxed)));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("draft.txt");
        let key = path.to_string_lossy().into_owned();
        let mut docs = HashMap::new();
        fs::write(&path, "before").unwrap();
        let first = read_document_from_disk(&mut docs, &path, key.clone()).unwrap();
        fs::write(&path, "external edit").unwrap();
        let reopened = read_document_from_disk(&mut docs, &path, key.clone()).unwrap();
        assert_eq!(reopened.text, "external edit");
        assert_eq!(reopened.original, "external edit");
        assert!(reopened.revision > first.revision);
        docs.get_mut(&key).unwrap().text = "unsaved edit".into();
        fs::write(&path, "another external edit").unwrap();
        let dirty = read_document_from_disk(&mut docs, &path, key.clone()).unwrap();
        assert_eq!(dirty.text, "unsaved edit");
        assert_eq!(dirty.original, "external edit");
        docs.get_mut(&key).unwrap().text = dirty.original;
        fs::remove_file(&path).unwrap();
        assert!(read_document_from_disk(&mut docs, &path, key).is_err());
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn editor_font_size_limits_and_reset() {
        assert_eq!(adjusted_font_size(16, "increase").unwrap(), 17);
        assert_eq!(adjusted_font_size(16, "decrease").unwrap(), 15);
        assert_eq!(adjusted_font_size(32, "increase").unwrap(), 32);
        assert_eq!(adjusted_font_size(12, "decrease").unwrap(), 12);
        assert_eq!(adjusted_font_size(24, "reset").unwrap(), 16);
        assert!(adjusted_font_size(16, "unknown").is_err());
        let saved = serde_json::to_vec(&EditorPreferences { font_size: 23 }).unwrap();
        assert_eq!(serde_json::from_slice::<EditorPreferences>(&saved).unwrap().font_size, 23);
    }
    #[test]
    fn workspace_keeps_project_history_and_independent_window_states() {
        let dir = std::env::temp_dir().join(format!("writingroom-workspace-test-{}", NEXT.fetch_add(1, Ordering::Relaxed)));
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("workspace-state.json");
        let first = TabState { tabs: vec![
            SavedTab { kind: TabKind::Html, path: "index.html".into(), title: "概要".into() },
            SavedTab { kind: TabKind::Text, path: "原稿.md".into(), title: "原稿.md".into() },
            SavedTab { kind: TabKind::Text, path: "index.html".into(), title: "index.html".into() },
        ], active: Some(1) };
        let mut workspace = WorkspaceStore { file: Some(file.clone()), ..Default::default() };
        workspace.saved.projects.insert("/project".into(), first.clone());
        workspace.live.insert("main".into(), first);
        workspace.live.insert("project-2".into(), TabState::default());
        workspace.previous_windows = vec![SavedWindow { root: "/previous-session".into(), state: TabState::default() }];
        let mut sessions = HashMap::from([
            ("main".into(), Session { root: "/project".into(), parent: None, file: None }),
            ("project-2".into(), Session { root: "/project".into(), parent: None, file: None }),
            ("editor-3".into(), Session { root: "/project".into(), parent: Some("main".into()), file: Some("原稿.md".into()) }),
        ]);
        persist_workspace(&mut workspace, &sessions).unwrap();
        let loaded: WorkspaceFile = serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
        assert_eq!(loaded.windows.len(), 2);
        assert_eq!(workspace.previous_windows[0].root, "/previous-session");
        assert_eq!(loaded.windows[0].state.active, Some(1));
        assert_eq!(loaded.windows[0].state.tabs[1].path, "原稿.md");
        assert!(matches!(loaded.windows[0].state.tabs[0].kind, TabKind::Html));
        assert!(matches!(loaded.windows[0].state.tabs[2].kind, TabKind::Text));
        assert!(loaded.windows[1].state.tabs.is_empty());
        sessions.clear();
        persist_workspace(&mut workspace, &sessions).unwrap();
        let loaded: WorkspaceFile = serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
        assert!(loaded.windows.is_empty());
        assert_eq!(workspace.previous_windows[0].root, "/previous-session");
        assert_eq!(loaded.projects["/project"].tabs.len(), 3);
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn external_links_preserve_japanese_paths_and_reject_internal_urls() {
        let url = external_url("bexteditor://open?path=/Users/Tadanori/drafts/00_はじめに.md").unwrap();
        assert_eq!(url.scheme(), "bexteditor");
        assert_eq!(url.query_pairs().find(|(key, _)| key == "path").unwrap().1,
            "/Users/Tadanori/drafts/00_はじめに.md");
        for url in ["javascript:alert(1)", "file:///tmp/a", "data:text/html,test", "project://localhost/main/a", "http://project.localhost/main/a", "invalid"] {
            assert!(external_url(url).is_err(), "{url}");
        }
    }
    #[test]
    fn history_is_recent_first_unique_and_bounded() {
        let mut history = HistoryFile::default();
        for i in 0..25 {
            remember(&mut history, format!("/projects/{i}"));
        }
        assert_eq!(history.projects.len(), HISTORY_LIMIT);
        assert_eq!(history.projects.first().unwrap(), "/projects/24");
        assert_eq!(history.projects.last().unwrap(), "/projects/5");
        remember(&mut history, "/projects/12".into());
        assert_eq!(history.projects.first().unwrap(), "/projects/12");
        assert_eq!(
            history
                .projects
                .iter()
                .filter(|p| *p == "/projects/12")
                .count(),
            1
        );
        let data = serde_json::to_vec(&history).unwrap();
        let loaded: HistoryFile = serde_json::from_slice(&data).unwrap();
        assert_eq!(loaded.projects, history.projects);
    }
    #[test]
    fn decode_unicode() {
        assert_eq!(decode("%E5%9F%B7%E7%AD%86.txt").unwrap(), "執筆.txt");
        assert!(decode("%GG").is_err());
    }
    #[test]
    fn rejects_escape() {
        assert!(scoped("/private/tmp", "../etc/passwd").is_err());
    }
    #[test]
    fn settings_and_atomic_save() {
        let dir = std::env::temp_dir().join(format!(
            "writingroom-test-{}",
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&dir).unwrap();
        let root = dir.to_str().unwrap();
        let mut c = config(root).unwrap();
        c.dashboards.insert("".into(), None);
        write_config(root, &c).unwrap();
        assert!(matches!(
            config(root).unwrap().dashboards.get(""),
            Some(None)
        ));
        let file = dir.join("原稿.txt");
        fs::write(&file, "before").unwrap();
        atomic_write(&file, "after\n執筆".as_bytes()).unwrap();
        assert_eq!(fs::read_to_string(&file).unwrap(), "after\n執筆");
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 2);
        std::os::unix::fs::symlink("/etc/passwd", dir.join("outside")).unwrap();
        assert!(scoped(root, "outside").is_err());
        fs::remove_dir_all(dir).unwrap();
    }
}
