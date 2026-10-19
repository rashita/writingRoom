//! Unsaved manuscripts belong to a window and never enter persisted tab state.
use crate::{lock, scoped, session, Doc, Result, Store, NEXT};
use std::{fs::OpenOptions, io::Write, path::Path, sync::{Mutex, atomic::Ordering}};
use tauri::{State, WebviewWindow};

pub(crate) struct Draft { pub owner: String, pub root: String, pub title: String, pub doc: Doc }
fn owned<'a>(store: &'a mut Store, owner: &str, id: &str) -> Result<&'a mut Draft> {
    store.drafts.get_mut(id).filter(|d| d.owner == owner).ok_or("無題の原稿が見つかりません".into())
}
#[tauri::command]
pub(crate) fn create_draft(window: WebviewWindow, state: State<Mutex<Store>>) -> Result<Doc> {
    let root = session(&window, &state)?.root;
    let number = NEXT.fetch_add(1, Ordering::Relaxed);
    let doc = Doc { path: format!("untitled-{number}"), text: String::new(), original: String::new(), revision: 0 };
    lock(&state).drafts.insert(doc.path.clone(), Draft { owner: window.label().into(), root, title: format!("無題 {number}"), doc: doc.clone() });
    Ok(doc)
}
#[tauri::command]
pub(crate) fn update_draft(window: WebviewWindow, state: State<Mutex<Store>>, id: String, text: String, revision: u64) -> Result<Doc> {
    let mut store = lock(&state);
    let draft = owned(&mut store, window.label(), &id)?;
    if draft.doc.revision != revision { return Err("編集内容の同期に失敗しました".into()); }
    draft.doc.text = text;
    draft.doc.revision += 1;
    Ok(draft.doc.clone())
}
#[tauri::command]
pub(crate) fn discard_draft(window: WebviewWindow, state: State<Mutex<Store>>, id: String) -> Result<()> {
    let mut store = lock(&state);
    owned(&mut store, window.label(), &id)?;
    store.drafts.remove(&id);
    Ok(())
}
fn save(store: &mut Store, owner: &str, id: &str, path: &str) -> Result<Doc> {
    let draft = owned(store, owner, id)?;
    let requested = Path::new(path);
    let parent = requested.parent().ok_or("保存先を選択してください")?;
    let parent = scoped(&draft.root, parent.to_str().ok_or("保存先を読み込めません")?)?;
    let target = parent.join(requested.file_name().ok_or("ファイル名を入力してください")?);
    let key = target.to_string_lossy().into_owned();
    let text = draft.doc.text.clone();
    // Refuse existing destinations, including symlinks and files with unsaved edits.
    if store.docs.contains_key(&key) { return Err("このファイルは開かれています。別の名前で保存してください。".into()); }
    let mut file = OpenOptions::new().write(true).create_new(true).open(&target)
        .map_err(|e| format!("新しい原稿を保存できません（既存ファイルは上書きできません）: {e}"))?;
    if let Err(error) = file.write_all(text.as_bytes()).and_then(|_| file.sync_all()) {
        drop(file);
        let _ = std::fs::remove_file(&target);
        return Err(format!("保存できません: {error}"));
    }
    let doc = Doc { path: key.clone(), original: text.clone(), text, revision: 0 };
    store.docs.insert(key, doc.clone());
    store.drafts.remove(id);
    Ok(doc)
}
#[tauri::command]
pub(crate) fn save_draft(window: WebviewWindow, state: State<Mutex<Store>>, id: String, path: String) -> Result<Doc> {
    save(&mut lock(&state), window.label(), &id, &path)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn drafts_save_only_to_new_files_inside_project_and_keep_text_on_failure() {
        let dir = std::env::temp_dir().join(format!("writingroom-draft-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
        std::fs::create_dir_all(&dir).unwrap();
        let root = dir.canonicalize().unwrap().to_string_lossy().into_owned();
        let mut store = Store::default();
        store.drafts.insert("draft".into(), Draft { owner: "window".into(), root: root.clone(), title: "無題".into(), doc: Doc { path: "draft".into(), text: "新しい原稿".into(), original: "".into(), revision: 2 } });
        let target = dir.join("原稿.md").to_string_lossy().into_owned();
        assert!(save(&mut store, "other", "draft", &target).is_err());
        assert!(save(&mut store, "window", "draft", &dir.parent().unwrap().join("outside.md").to_string_lossy()).is_err());
        std::fs::write(&target, "existing").unwrap();
        assert!(save(&mut store, "window", "draft", &target).is_err());
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "existing");
        assert_eq!(store.drafts["draft"].doc.text, "新しい原稿");
        let target = dir.join("新規 [1].md");
        let doc = save(&mut store, "window", "draft", &target.to_string_lossy()).unwrap();
        assert_eq!(doc.text, doc.original);
        assert_eq!(std::fs::read_to_string(target).unwrap(), "新しい原稿");
        assert!(store.drafts.is_empty());
        assert!(store.docs.contains_key(&doc.path));
        std::fs::remove_dir_all(dir).unwrap();
    }
}
