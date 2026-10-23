import Cocoa
import WebKit

// Run from the repository root:
// swift tests/manual/enter-webkit.swift
// swift tests/manual/enter-webkit.swift --fixed
// Opens a temporary WKWebView; sends a native Enter key without an IME.
let fixed = CommandLine.arguments.contains("--fixed")
let bundle = try String(contentsOfFile: "src/cm-bundle.js", encoding: .utf8)
let expression = try NSRegularExpression(pattern: #"export\{([^}]+)\};?\s*$"#)
let match = expression.firstMatch(in: bundle, range: NSRange(bundle.startIndex..., in: bundle))!
let exports = String(bundle[Range(match.range(at: 1), in: bundle)!]).split(separator: ",").map { item -> String in
    let pair = item.components(separatedBy: " as ").map { $0.trimmingCharacters(in: .whitespaces) }
    return pair.last! + ":" + pair.first!
}.joined(separator: ",")
let script = String(bundle[..<Range(match.range, in: bundle)!.lowerBound]) + "window.cm={" + exports + "};"
let application = NSApplication.shared
application.setActivationPolicy(.accessory)
let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 800, height: 600), styleMask: [.titled], backing: .buffered, defer: false)
let web = WKWebView(frame: window.contentView!.bounds)
window.contentView!.addSubview(web)
window.makeKeyAndOrderFront(nil)
class Probe: NSObject, WKNavigationDelegate {
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        var script = #"""
        window.records = [];
        const {EditorState, EditorView, keymap, defaultKeymap, drawSelection} = cm;
        window.view = new EditorView({parent: document.body, state: EditorState.create({doc:'第一段落。\n\n第二段落。', selection:{anchor:5}, extensions:[drawSelection(), keymap.of(defaultKeymap.filter(b => b.key !== 'Enter' && b.key !== 'Mod-Enter')), EditorView.updateListener.of(u => {if(u.docChanged) records.push({type:'transaction', text:u.state.doc.toString()})})]})});
        for (const type of ['keydown','beforeinput','input']) view.contentDOM.addEventListener(type, e => records.push({type, key:e.key, inputType:e.inputType, html:view.contentDOM.innerHTML}), true);
        view.focus();
        'ready';
        """#
        if fixed {
            script = script.replacingOccurrences(of: "keymap.of(defaultKeymap.filter(b => b.key !== 'Enter' && b.key !== 'Mod-Enter'))", with: "keymap.of([{key:'Enter',run:({state,dispatch}) => {dispatch(state.update(state.replaceSelection(state.lineBreak), {userEvent:'input.type'}));return true;}},...defaultKeymap.filter(b => b.key !== 'Enter' && b.key !== 'Mod-Enter')])")
        }
        webView.evaluateJavaScript(script) { result, error in
            if let error = error { print(error); exit(1) }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
                window.makeFirstResponder(webView)
                let event = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber, context: nil, characters: "\r", charactersIgnoringModifiers: "\r", isARepeat: false, keyCode: 36)!
                webView.keyDown(with: event)
                webView.evaluateJavaScript("JSON.stringify({html:view.contentDOM.innerHTML, records})") { result, error in
                    print("IMMEDIATE", result ?? error as Any)
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
                        webView.evaluateJavaScript("JSON.stringify({text:view.state.doc.toString(),html:view.contentDOM.innerHTML,records})") { result, error in
                            print("FINAL", result ?? error as Any)
                            exit(0)
                        }
                    }
                }
            }
        }
    }
}
let probe = Probe()
web.navigationDelegate = probe
web.loadHTMLString("<html><body><script type=\"module\">" + script + "</script></body></html>", baseURL: nil)
DispatchQueue.main.asyncAfter(deadline: .now() + 20) { print("timeout"); exit(2) }
application.run()
