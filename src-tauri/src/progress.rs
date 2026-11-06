//! Optional progress recording. Remove this module and its menu/IPC connections to purge.
use crate::{session, Result, Store};
use serde::{Deserialize, Serialize};
use std::{path::Path, process::Command, sync::Mutex};
use tauri::{State, WebviewWindow};

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
pub(crate) fn preview_project_progress(window: WebviewWindow, state: State<Mutex<Store>>) -> Result<ProjectPreview> {
    let root = session(&window, &state)?.root;
    project_preview(Path::new(&root))
}
#[tauri::command]
pub(crate) fn commit_project_progress(window: WebviewWindow, state: State<Mutex<Store>>, expected: ProjectPreview, message: String) -> Result<String> {
    let root = session(&window, &state)?.root;
    project_commit(Path::new(&root), &expected, &message)
}

// Browsing history never saves documents or changes the index.
#[derive(Serialize, Debug)]
pub(crate) struct HistoryEntry {
    id: String, short_id: String, date: String, author: String, message: String,
}
fn history(dir: &Path, scope: &str, offset: usize) -> Result<Vec<HistoryEntry>> {
    git(dir, &["rev-parse", "--show-toplevel"])?;
    if git(dir, &["rev-parse", "--verify", "--quiet", "HEAD"]).is_err() { return Ok(vec![]); }
    let skip = format!("--skip={offset}");
    let output = git(dir, &["log", "--encoding=UTF-8", "-z", "--format=%H%x00%h%x00%aI%x00%an%x00%B", "--max-count=50", &skip, "HEAD", "--", scope])?;
    let fields: Vec<_> = output.split_terminator('\0').collect();
    Ok(fields.chunks_exact(5).map(|f| HistoryEntry {
        id: f[0].into(), short_id: f[1].into(), date: f[2].into(), author: f[3].into(), message: f[4].trim_end().into(),
    }).collect())
}
fn history_diff(dir: &Path, scope: &str, id: &str) -> Result<String> {
    if ![40, 64].contains(&id.len()) || !id.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("記録のIDが不正です".into());
    }
    git(dir, &["-c", "core.quotePath=false", "show", "--format=", "--root", "--first-parent", "--patch", "--stat", "--no-ext-diff", "--no-textconv", "--no-color", id, "--", scope])
}
#[tauri::command]
pub(crate) fn list_progress_history(window: WebviewWindow, state: State<Mutex<Store>>, offset: usize) -> Result<Vec<HistoryEntry>> {
    let root = session(&window, &state)?.root;
    history(Path::new(&root), ".", offset)
}
#[tauri::command]
pub(crate) fn progress_history_diff(window: WebviewWindow, state: State<Mutex<Store>>, id: String) -> Result<String> {
    let root = session(&window, &state)?.root;
    history_diff(Path::new(&root), ".", &id)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn history_scopes_pages_and_reads_initial_diff_without_changing_staging() {
        let dir = std::env::temp_dir().join(format!("writingroom-history-{}-{}", std::process::id(), crate::NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)));
        let root = dir.join("project");
        std::fs::create_dir_all(&root).unwrap();
        git(&dir, &["init"]).unwrap();
        git(&dir, &["config", "user.name", "Test"]).unwrap();
        git(&dir, &["config", "user.email", "test@example.invalid"]).unwrap();
        assert!(history(&root, ".", 0).unwrap().is_empty());
        std::fs::write(root.join("原稿 [1].md"), "first\n").unwrap();
        std::fs::write(dir.join("outside.md"), "outside\n").unwrap();
        git(&dir, &["add", "."]).unwrap();
        git(&dir, &["commit", "-m", "初稿", "-m", "本文の説明\n二行目"]).unwrap();
        let first = history(&root, "原稿 [1].md", 0).unwrap();
        assert_eq!(first.len(), 1);
        assert!(first[0].message.contains("本文の説明\n二行目"));
        assert!(history_diff(&root, "原稿 [1].md", &first[0].id).unwrap().contains("+first"));
        assert!(!history_diff(&root, ".", &first[0].id).unwrap().contains("outside.md"));
        std::fs::write(dir.join("outside.md"), "changed outside\n").unwrap();
        git(&dir, &["commit", "-am", "outside only"]).unwrap();
        std::fs::write(root.join("second.md"), "second\n").unwrap();
        git(&dir, &["add", "."]).unwrap();
        git(&dir, &["commit", "-m", "second manuscript"]).unwrap();
        std::fs::write(dir.join("outside.md"), "staged\n").unwrap();
        git(&dir, &["add", "outside.md"]).unwrap();
        let staging = git(&dir, &["diff", "--cached"]).unwrap();
        let entries = history(&root, ".", 0).unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].message, "second manuscript");
        assert_eq!(history(&root, ".", 1).unwrap()[0].id, first[0].id);
        assert_eq!(history(&root, "原稿 [1].md", 0).unwrap().len(), 1);
        assert!(history(&root, "untracked.md", 0).unwrap().is_empty());
        assert!(history_diff(&root, ".", "--output=bad").is_err());
        assert!(history_diff(&root, ".", &entries[0].id).unwrap().contains("+second"));
        assert_eq!(git(&dir, &["diff", "--cached"]).unwrap(), staging);
        std::fs::remove_dir_all(dir).unwrap();
    }
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
}
