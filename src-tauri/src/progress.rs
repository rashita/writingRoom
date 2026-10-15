//! Optional progress recording. Remove this module and its menu/IPC connections to purge.
use crate::{lock, scoped, session, Result, Store};
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
pub(crate) struct Preview { head: String, pub diff: String }

fn preview(file: &Path) -> Result<Preview> {
    let dir = file.parent().ok_or("原稿の場所を取得できません")?;
    let name = file.file_name().and_then(|s| s.to_str()).ok_or("ファイル名を読み込めません")?;
    git(dir, &["ls-files", "--error-unmatch", "--", name])
        .map_err(|_| "極小版ではGitで追跡済みの原稿のみ記録できます。先にターミナルでGitに登録してください。".to_string())?;
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
fn target(window: &WebviewWindow, state: &Mutex<Store>, path: &str) -> Result<std::path::PathBuf> {
    let s = session(window, state)?;
    let file = scoped(&s.root, path)?;
    let store = lock(state);
    let doc = store.docs.get(&file.to_string_lossy().into_owned()).ok_or("原稿が開かれていません")?;
    if doc.text != doc.original { return Err("原稿を保存してから進捗を記録してください".into()); }
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

#[cfg(test)]
mod tests {
    use super::*;
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
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
