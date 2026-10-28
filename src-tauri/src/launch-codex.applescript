on run argv
    tell application "Ghostty"
        set cfg to new surface configuration
        set initial working directory of cfg to item 1 of argv
        set command of cfg to "/bin/zsh -lic 'codex \"プロジェクトを開始します\"'"
        new window with configuration cfg
        activate
    end tell
end run
