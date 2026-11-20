// 產生 manifest "key"，讓未封裝載入的擴充功能 ID 固定（不必每台機器重新註冊 host）。
// 私鑰不需要也不保存；之後若要上架商店，商店會給正式 ID，請用 install.ps1 -ExtensionId 重新註冊。
//   node tools/gen-key.js
const crypto = require('crypto');
const { publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const der = publicKey.export({ type: 'spki', format: 'der' });
const id = crypto.createHash('sha256').update(der).digest('hex').slice(0, 32)
  .replace(/[0-9a-f]/g, c => String.fromCharCode(97 + parseInt(c, 16)));
console.log(JSON.stringify({ key: der.toString('base64'), id }));
