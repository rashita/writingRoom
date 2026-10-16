//! Optional progress recording. Remove this module and its menu/IPC connections to purge.
use crate::{lock, scoped, session, Result, Store};
use serde::{Deserialize, Serialize};
use std::{path::Path, process::Command, sync::Mutex};
use tauri::{Emitter, State, WebviewWindow};

fn git(dir: &Path, args: &[&str]) -> Result<String> {
    let output = Command::new("git").current_dir(dir)
        .env("GIT_LITERAL_PATHSPECS", "1").args(args).output()
        .map_err(|e| format!("Gitを実行できません: {e}"))?;
    if !output.status.success() {
        return Err(format!("Git: {}", String::from_utf8_lossy(&output.stderr).trim()));
    }
    String::from_utf8(output.stdout).map_err(|_| "Gitの出力をUTF-8で読み込めません".into())
}
#[derive(Serialize, Deserialize, PartialEq, Debug)]
pub(crate) struct Preview { head: String, pub diff: String }

fn preview(file: &Path) -> Result<Preview> {
    let dir = file.parent().ok_or("原稿の場所を取得できません")?;
    let name = file.file_name().and_then(|s| s.to_str()).ok_or("ファイル名を読み込めません")?;
    git(dir, &["ls-files", "--error-unmatch", "--", name])
        .map_err(|_| "Gitで未追跡の原稿です。「履歴 → このファイルを追跡に追加」を実行してください。".to_string())?;
    let head = git(dir, &["rev-parse", "HEAD"])?;
    let diff = git(dir, &["diff", "--no-ext-diff", "--no-textconv", "--no-color", "HEAD", "--", name])?;
    Ok(Preview { head, diff })
}
fn commit(file: &Path, expected: &Preview, message: &str) -> Result<String> {
    if message.trim().is_empty() { return Err("記録の内容を入力してください".into()); }
    let current = preview(file)?;
    if &current != expected { return Err("確認後に原稿またはGitの履歴が変わりました。画面を閉じて差分を確認し直してください。".into()); }
    if current.diff.is_empty() { return Err("記録する変更がありません".into()); }
    let dir = file.parent().unwrap();
    // Never include unrelated staged files. Let Git reject conflicts and in-progress merges.
    git(dir, &["commit", "--only", "-m", message.trim(), "--", file.file_name().unwrap().to_str().unwrap()])
}
// Adding an already tracked file must not restage its modifications.
fn track(file: &Path) -> Result<bool> {
    let dir = file.parent().ok_or("原稿の場所を取得できません")?;
    let name = file.file_name().and_then(|s| s.to_str()).ok_or("ファイル名を読み込めません")?;
    git(dir, &["rev-parse", "--show-toplevel"])?;
    if !git(dir, &["ls-files", "--", name])?.is_empty() { return Ok(false); }
    git(dir, &["add", "--", name])?;
    Ok(true)
}
#[tauri::command]
pub(crate) fn track_document(window: WebviewWindow, state: State<Mutex<Store>>, path: String) -> Result<bool> {
    track(&target(&window, &state, &path)?)
}
fn target(window: &WebviewWindow, state: &Mutex<Store>, path: &str) -> Result<std::path::PathBuf> {
    let s = session(window, state)?;
    let file = scoped(&s.root, path)?;
    let store = lock(state);
    let doc = store.docs.get(&file.to_string_lossy().into_owned()).ok_or("原稿が開かれていません")?;
    if doc.text != doc.original { return Err("原稿を保存してから履歴の操作を実行してください".into()); }
    Ok(file)
}
#[tauri::command]
pub(crate) fn preview_progress(window: WebviewWindow, state: State<Mutex<Store>>, path: String) -> Result<Preview> {
    preview(&target(&window, &state, &path)?)
}
#[tauri::command]
pub(crate) fn commit_progress(window: WebviewWindow, state: State<Mutex<Store>>, path: String, expected: Preview, message: String) -> Result<String> {
    commit(&target(&window, &state, &path)?, &expected, &message)
}

#[derive(Serialize, Deserialize, PartialEq, Debug)]
pub(crate) struct ProjectPreview { head: String, tree: String, pub diff: String }

// A temporary index previews additions and binary changes without touching staging.
fn project_preview(root: &Path) -> Result<ProjectPreview> {
    let head = git(root, &["rev-parse", "HEAD"])?;
    let index = std::env::temp_dir().join(format!("writingroom-index-{}-{}", std::process::id(), crate::NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)));
    let run = |args: &[&str]| -> Result<String> {
        let output = Command::new("git").current_dir(root).env("GIT_LITERAL_PATHSPECS", "1")
            .env("GIT_INDEX_FILE", &index).args(args).output().map_err(|e| e.to_string())?;
        if !output.status.success() { return Err(format!("Git: {}", String::from_utf8_lossy(&output.stderr).trim())); }
        String::from_utf8(output.stdout).map_err(|e| e.to_string())
    };
    let result = (|| {
        run(&["read-tree", "HEAD"])?;
        run(&["add", "-A", "--", "."])?;
        let tree = run(&["write-tree"])?;
        let diff = run(&["diff", "--cached", "--no-ext-diff", "--no-textconv", "--no-color", "HEAD", "--", "."])?;
        Ok(ProjectPreview { head, tree, diff })
    })();
    let _ = std::fs::remove_file(&index);
    result
}
fn project_commit(root: &Path, expected: &ProjectPreview, message: &str) -> Result<String> {
    if message.trim().is_empty() { return Err("記録の内容を入力してください".into()); }
    if &project_preview(root)? != expected { return Err("確認後にファイルまたは履歴が変わりました。差分を確認し直してください。".into()); }
    if expected.diff.is_empty() { return Err("記録する変更がありません".into()); }
    git(root, &["add", "-A", "--", "."])?;
    git(root, &["commit", "--only", "-m", message.trim(), "--", "."])
}
#[tauri::command]
pub(crate) fn preview_project_progress(window: WebviewWindow, app: tauri::AppHandle, state: State<Mutex<Store>>) -> Result<ProjectPreview> {
    let root = session(&window, &state)?.root;
    crate::save_project_documents(&root, &mut lock(&state), |doc| app.emit("document-changed", doc).map_err(|e| e.to_string()))?;
    project_preview(Path::new(&root))
}
#[tauri::command]
pub(crate) fn commit_project_progress(window: WebviewWindow, state: State<Mutex<Store>>, expected: ProjectPreview, message: String) -> Result<String> {
    let root = session(&window, &state)?.root;
    if lock(&state).docs.values().any(|d| Path::new(&d.path).starts_with(&root) && d.text != d.original) {
        return Err("未保存の編集があります。差分を確認し直してください。".into());
    }
    project_commit(Path::new(&root), &expected, &message)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn project_records_additions_changes_deletions_and_preserves_outside_staging() {
        let dir = std::env::temp_dir().join(format!("writingroom-project-{}-{}", std::process::id(), crate::NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)));
        let root = dir.join("project");
        std::fs::create_dir_all(&root).unwrap();
        git(&dir, &["init"]).unwrap();
        git(&dir, &["config", "user.name", "Test"]).unwrap();
        git(&dir, &["config", "user.email", "test@example.invalid"]).unwrap();
        for name in ["edit.md", "delete.md"] { std::fs::write(root.join(name), "before").unwrap(); }
        std::fs::write(dir.join("outside.md"), "before").unwrap();
        git(&dir, &["add", "."]).unwrap();
        git(&dir, &["commit", "-m", "initial"]).unwrap();
        std::fs::write(dir.join("outside.md"), "staged").unwrap();
        git(&dir, &["add", "outside.md"]).unwrap();
        std::fs::write(root.join("edit.md"), "after").unwrap();
        std::fs::remove_file(root.join("delete.md")).unwrap();
        std::fs::write(root.join("new [1].md"), "new").unwrap();
        std::fs::write(root.join("empty.md"), "").unwrap();
        std::fs::write(root.join(".gitignore"), "ignored\n").unwrap();
        std::fs::write(root.join("ignored"), "secret").unwrap();
        let staging = git(&dir, &["diff", "--cached"]).unwrap();
        let expected = project_preview(&root).unwrap();
        assert_eq!(staging, git(&dir, &["diff", "--cached"]).unwrap());
        assert!(expected.diff.contains("new [1].md"));
        assert!(!expected.diff.contains("secret"));
        std::fs::write(root.join("binary"), [0, 1, 2]).unwrap();
        assert!(project_commit(&root, &expected, "stale").is_err());
        let expected = project_preview(&root).unwrap();
        std::fs::write(root.join("binary"), [0, 1, 3]).unwrap();
        assert!(project_commit(&root, &expected, "stale binary").is_err());
        let expected = project_preview(&root).unwrap();
        project_commit(&root, &expected, "project progress").unwrap();
        assert!(project_preview(&root).unwrap().diff.is_empty());
        assert_eq!(staging, git(&dir, &["diff", "--cached"]).unwrap());
        assert_eq!(git(&dir, &["show", "HEAD:outside.md"]).unwrap(), "before");
        assert!(git(&dir, &["show", "HEAD:project/delete.md"]).is_err());
        assert_eq!(git(&dir, &["show", "HEAD:project/new [1].md"]).unwrap(), "new");
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn records_only_reviewed_file_and_preserves_unrelated_staging() {
        let dir = std::env::temp_dir().join(format!("writingroom-progress-{}-{}", std::process::id(), crate::NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)));
        std::fs::create_dir_all(&dir).unwrap();
        git(&dir, &["init"]).unwrap();
        git(&dir, &["config", "user.name", "Test"]).unwrap();
        git(&dir, &["config", "user.email", "test@example.invalid"]).unwrap();
        let file = dir.join("原稿 [1].md");
        std::fs::write(&file, "before\n").unwrap();
        std::fs::write(dir.join("other.md"), "before\n").unwrap();
        git(&dir, &["add", "."]).unwrap();
        git(&dir, &["commit", "-m", "initial"]).unwrap();
        std::fs::write(&file, "after\n").unwrap();
        std::fs::write(dir.join("other.md"), "staged\n").unwrap();
        git(&dir, &["add", "other.md"]).unwrap();
        let expected = preview(&file).unwrap();
        assert!(expected.diff.contains("+after"));
        assert!(commit(&file, &expected, " ").is_err());
        std::fs::write(&file, "changed again\n").unwrap();
        assert!(commit(&file, &expected, "rewrite").is_err());
        let expected = preview(&file).unwrap();
        commit(&file, &expected, "rewrite").unwrap();
        assert!(preview(&file).unwrap().diff.is_empty());
        assert_eq!(git(&dir, &["show", "HEAD:other.md"]).unwrap(), "before\n");
        assert!(git(&dir, &["diff", "--cached"]).unwrap().contains("+staged"));
        let untracked = dir.join("new.md");
        std::fs::write(&untracked, "new").unwrap();
        assert!(preview(&untracked).is_err());
        assert!(track(&untracked).unwrap());
        assert!(preview(&untracked).unwrap().diff.contains("+new"));
        std::fs::write(&untracked, "updated\n").unwrap();
        assert!(!track(&untracked).unwrap());
        assert_eq!(git(&dir, &["show", ":new.md"]).unwrap(), "new");
        let expected = preview(&untracked).unwrap();
        commit(&untracked, &expected, "new manuscript").unwrap();
        assert_eq!(git(&dir, &["show", "HEAD:new.md"]).unwrap(), "updated\n");
        assert!(git(&dir, &["diff", "--cached"]).unwrap().contains("+staged"));
        std::fs::write(dir.join(".gitignore"), "ignored.md\n").unwrap();
        let ignored = dir.join("ignored.md");
        std::fs::write(&ignored, "ignored").unwrap();
        assert!(track(&ignored).is_err());
        let empty = dir.join("empty.md");
        std::fs::write(&empty, "").unwrap();
        assert!(track(&empty).unwrap());
        let expected = preview(&empty).unwrap();
        assert!(!expected.diff.is_empty());
        commit(&empty, &expected, "empty manuscript").unwrap();
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
