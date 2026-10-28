import Cocoa
import WebKit

// Run from the repository root:
// swift tests/manual/typewriter-webkit.swift
// Opens a temporary WKWebView and drives native marked text / commit APIs.
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
let controller = try String(contentsOfFile: "src/typewriter.js", encoding: .utf8)
    .replacingOccurrences(of: "import { EditorView } from './cm-bundle.js';", with: "const {EditorView} = cm;")
    .replacingOccurrences(of: "export function", with: "function")
class Probe: NSObject, WKNavigationDelegate {
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        webView.evaluateJavaScript("""
        window.records = [];
        const {EditorState, keymap, drawSelection} = cm;
        let mode;
        window.view = new cm.EditorView({parent: document.body, state: EditorState.create({
          doc: ('本文です。\\n').repeat(100) + '末尾', extensions:[drawSelection(),cm.EditorView.lineWrapping,
          cm.EditorView.updateListener.of(u => { mode?.update(u); records.push({event:'update', doc:u.docChanged, geometry:u.geometryChanged, transactions:u.transactions.map(t => ({scroll:t.scrollIntoView}))}); })]
        })});
        view.dom.classList.add('manuscript-editor');
        mode = createTypewriter(view, true);
        view.dispatch({selection:{anchor:view.state.doc.length}, effects:cm.EditorView.scrollIntoView(view.state.doc.length,{y:'center'})});
        view.focus();
        for (const name of ['compositionstart','compositionupdate','compositionend','beforeinput','input','scroll'])
          view.contentDOM.addEventListener(name,e => records.push({event:name, at:performance.now(), input:e.inputType, top:view.scrollDOM.scrollTop}),true);
        let previous = '';
        function sample() {
          const rect = view.coordsAtPos(view.state.selection.main.head);
          const value = JSON.stringify({top:view.scrollDOM.scrollTop,height:view.scrollDOM.scrollHeight,caret:rect?.top,line:view.contentDOM.lastChild?.getBoundingClientRect().height,composing:view.composing});
          if(value !== previous) {records.push({event:'frame', at:performance.now(), value:JSON.parse(value)});previous=value;}
          setTimeout(sample, 5);
        }
        sample();
        """) { _, error in
            if let error = error { print(error); exit(1) }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                func findClient(_ view: NSView) -> (any NSTextInputClient)? {
                    if let client = view as? any NSTextInputClient { return client }
                    for child in view.subviews { if let client = findClient(child) {return client} }
                    return nil
                }
                window.makeFirstResponder(webView)
                guard let client = findClient(webView) else {print("No native text input client");exit(3)}
                webView.evaluateJavaScript("view.dispatch(view.state.update(view.state.replaceSelection('\\n'),{scrollIntoView:true,userEvent:'input.type'}))")
                DispatchQueue.main.asyncAfter(deadline:.now() + 0.2) {
                client.setMarkedText("にほんご", selectedRange:NSRange(location:4,length:0), replacementRange:NSRange(location:NSNotFound,length:0))
                DispatchQueue.main.asyncAfter(deadline:.now() + 0.3) {
                    client.insertText("日本語", replacementRange:NSRange(location:NSNotFound,length:0))
                    DispatchQueue.main.asyncAfter(deadline:.now() + 0.5) {
                        webView.evaluateJavaScript("JSON.stringify({records,text:view.state.doc.toString().slice(-30)})") { result, error in
                            print(result ?? error as Any); exit(0)
                        }
                    }
                }
                }
            }
        }
    }
}
let probe = Probe()
web.navigationDelegate = probe
let css = "html,body{margin:0;height:100%}.manuscript-editor{height:100%;font-size:16px}.manuscript-editor .cm-scroller{overflow:auto;line-height:1.9;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}.manuscript-editor .cm-content{padding:40px 24px}.manuscript-editor .cm-line{padding:0}.manuscript-editor .typewriter-mode .cm-content{padding-block:var(--typewriter-padding)}"
web.loadHTMLString("<html><head><style>" + css + "</style></head><body><script>" + "(function(){" + script + "})();" + controller + "</script></body></html>", baseURL:nil)
DispatchQueue.main.asyncAfter(deadline:.now() + 15) {print("timeout");exit(2)}
application.run()
