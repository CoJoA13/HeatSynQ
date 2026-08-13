# Vendored font provenance (Phase 7 spec §6.2, owner ruling 5)

The render runtime's four base families and where every byte in this directory came from.
Each family ships ONE way (the one-mechanism-per-family rule, `render.ts`'s font-map comment):

- **Roboto** — NOT vendored here. It stays decoded from pdfmake's own bundled vfs
  (`pdfmake/build/vfs_fonts.js`), the mechanism every pre-Phase-7 document already renders
  through; its font-map key is unchanged so those documents render byte-for-byte the same.
  License: Apache-2.0 (Roboto's own, shipped inside the pdfmake package).
- **Liberation Sans / Liberation Serif** — copied from Fedora's packaged fonts (below).
  License: SIL OFL 1.1, each family's `LICENSE` copied from the same package.
- **Roboto Mono** — fetched from the family's official upstream repository
  `googlefonts/RobotoMono` at commit `111eb14e367888c9374da4da0b018e72cf8ac46d` — the exact
  commit `google/fonts`' own `ofl/robotomono/upstream_info.md` pins. (The aggregate
  `google/fonts` repo now carries only variable-weight `[wght]` TTFs, which cannot feed
  pdfmake's four fixed style slots without instancing the bytes.) License: SIL OFL 1.1
  (`OFL.txt` from the same commit).

## liberation-sans/ — from `liberation-sans-fonts-2.1.5-15.fc44.noarch`

Source: `/usr/share/fonts/liberation-sans-fonts/` (TTFs), `/usr/share/licenses/liberation-sans-fonts/LICENSE`.

| File | sha256 |
|---|---|
| LiberationSans-Regular.ttf | `76d04c18ea243f426b7de1f3ad208e927008f961dc5945e5aad352d0dfde8ee8` |
| LiberationSans-Bold.ttf | `788abee4c806d660e8aee46689dd8540cd4bb98da03dcc9d171ce3efd99a9173` |
| LiberationSans-Italic.ttf | `e5bae5c4cde31f22142753855f4f8fb86da6ff39955ed3c0a11248b0d16948b0` |
| LiberationSans-BoldItalic.ttf | `698da70fc191cc5f33ad4d6d3fe830fe4624b898ea2e3169955928b7c491f1ee` |
| LICENSE | `93fed46019c38bbe566b479d22148e2e8a1e85ada614accb0211c37b2c61c19b` |

## liberation-serif/ — from `liberation-serif-fonts-2.1.5-15.fc44.noarch`

Source: `/usr/share/fonts/liberation-serif-fonts/` (TTFs), `/usr/share/licenses/liberation-serif-fonts/LICENSE`
(same OFL text as the Sans package, sha256 identical).

| File | sha256 |
|---|---|
| LiberationSerif-Regular.ttf | `058ea80864aef09a23f45cbec2bb5400bc3dfbdea01c3f10538a21fcb497fb74` |
| LiberationSerif-Bold.ttf | `d754ba427cfe0bca54ae052384baa8f842da5bd6550ad4da024ac441e7a7d5ce` |
| LiberationSerif-Italic.ttf | `0e3dea9f8d613e006ccfa62201f33e265d19167bd0907725c3e145368b04fc2e` |
| LiberationSerif-BoldItalic.ttf | `f17db8af71e24d2066b587546021d4f0b296be389512b658dec3c09affeb11a7` |
| LICENSE | `93fed46019c38bbe566b479d22148e2e8a1e85ada614accb0211c37b2c61c19b` |

## roboto-mono/ — from `googlefonts/RobotoMono` @ `111eb14e367888c9374da4da0b018e72cf8ac46d`

Source: `https://raw.githubusercontent.com/googlefonts/RobotoMono/111eb14e367888c9374da4da0b018e72cf8ac46d/fonts/ttf/<file>` and `/OFL.txt`.

| File | sha256 |
|---|---|
| RobotoMono-Regular.ttf | `af0bff7599c3df3831755c16e39b3c496df74b8c8d8a1161b14dc8461be17cb4` |
| RobotoMono-Bold.ttf | `3ecf35e5e87accc7578b605d1f5f0bc30d88b195d6807bec8a0c57f6aa95c4db` |
| RobotoMono-Italic.ttf | `4549325cd2d10938d37d63eba2aaca7c2e16e48322dc767576eab45e512b6ad2` |
| RobotoMono-BoldItalic.ttf | `a0f16567447311eaf42a35f6c50eb64b911694b42f1b01038e3b7e92c20f131d` |
| OFL.txt | `50ab8dd54680d3473f649c9db86fece88434d097c7834475c1c72d2f8c429215` |
