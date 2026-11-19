// Genera los PNG del icono a partir de los SVG de assets/ con el Chromium de Electron.
// Uso: npx electron tools/render-icons.js
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const ASSETS = path.join(__dirname, '..', 'assets');
const OUTPUTS = [
  { svg: 'icon.svg', png: 'icon.png', size: 512 },  // ventana, instalador y .ico (electron-builder)
  { svg: 'icon.svg', png: 'icon-64.png', size: 64 }, // logo de la barra lateral
  { svg: 'tray.svg', png: 'tray.png', size: 16 },    // bandeja al 100 %
  { svg: 'tray.svg', png: 'tray@2x.png', size: 32 }, // bandeja al 200 % (Electron elige solo)
];

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 100, height: 100 });
  await win.loadURL('data:text/html,<canvas></canvas>');
  for (const o of OUTPUTS) {
    const svg = fs.readFileSync(path.join(ASSETS, o.svg), 'utf8');
    const dataUrl = await win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const c = document.querySelector('canvas');
        c.width = c.height = ${o.size};
        const ctx = c.getContext('2d');
        ctx.imageSmoothingQuality = 'high';
        ctx.clearRect(0, 0, ${o.size}, ${o.size});
        ctx.drawImage(img, 0, 0, ${o.size}, ${o.size});
        resolve(c.toDataURL('image/png'));
      };
      img.onerror = () => reject(new Error('svg inválido'));
      img.src = 'data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}';
    })`);
    fs.writeFileSync(path.join(ASSETS, o.png), Buffer.from(dataUrl.split(',')[1], 'base64'));
    console.log(`${o.png} (${o.size} px)`);
  }
  app.quit();
});
