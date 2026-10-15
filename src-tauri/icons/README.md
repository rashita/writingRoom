# Writing Room icon

Built-in ImageGenで生成した、生成りの背景・原稿用紙・落ち着いた緑の万年筆をモチーフにしたMacアプリアイコンです。画面の配色に合わせ、余白とシンプルな形を重視しています。

- 原画像: `writing-room-source.png`
- 旧アイコンの原画像: `writing-room-source-v1.png`
- Mac用: `icon.icns`
- Tauri用: `icon.png`、`32x32.png`、`128x128.png`、`128x128@2x.png`
- 各サイズへの変換: `npm exec tauri icon -- src-tauri/icons/writing-room-source.png`

## Generation prompt

A clean flat vector-style macOS app icon, one icon on transparent canvas. An ivory #f4f3ee rounded square with mathematically smooth clean edges and generous transparent margin. Inside: two overlapping white manuscript sheets outlined in sage gray with three short horizontal strokes, and one bold dark sage green #31604f pen diagonally at lower right. Quiet minimalist Japanese stationery design, generous whitespace, restrained warm neutral colors. Flat solid fills, sharp smooth lines. Absolutely NO paper texture, NO distressed edges, NO speckles, NO grain, NO brush marks, NO shadow, NO glow. Outer perimeter must be perfectly smooth and clean, no stray pixels. Transparent outside the rounded square. No words or letters. Square 1024px icon.

`transparent_background: true`
