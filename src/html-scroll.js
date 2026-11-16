// Keep only serializable coordinates on the tab, so future session persistence
// can include htmlScroll without depending on iframe or window objects.
export function trackHtmlScroll(host, iframe, tab) {
    const receive = event => {
        if (event.source !== iframe.contentWindow) return;
        if (event.data?.type === 'project-scroll-ready') {
            iframe.contentWindow.postMessage({
                type: 'project-scroll-restore',
                position: tab.htmlScroll ?? { top: 0, left: 0 }
            }, '*');
        } else if (event.data?.type === 'project-scroll') {
            const position = event.data.position;
            if (!position || !Number.isFinite(position.top) || !Number.isFinite(position.left)) return;
            tab.htmlScroll = { top: position.top, left: position.left };
        }
    };
    host.addEventListener('message', receive);
    return () => host.removeEventListener('message', receive);
}
