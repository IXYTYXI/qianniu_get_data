#!/usr/bin/env node
/** 仅测试弹幕导出按钮点击 */
const path = require('path');
const config = require('./config');
const { launchBrowser, waitForLogin } = require('./browser');
const { importBarrageToFeishu } = require('./feishu');

const LIVE_ID = process.argv[2] || '607413';

async function main() {
  const { context, page } = await launchBrowser();
  try {
    if (!(await waitForLogin(page, { skipLogin: true }))) throw new Error('未登录');
    await page.goto(`https://live.pili-live.com/livestream/toLive?id=${LIVE_ID}&enterprise_id=3112`, {
      timeout: config.navigationTimeout,
    });
    await page.waitForTimeout(3000);

    const chatPanel = page.locator('.chat').first();
    const exportBtn = chatPanel.locator('img.footer-t-icon[src*="icon-chat-export"]').first();
    const src = await exportBtn.getAttribute('src');
    console.log('导出按钮 src:', src);

    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 60000 }),
      exportBtn.click(),
    ]);
    console.log('文件名:', download.suggestedFilename());
    const savePath = path.join(config.downloadDir, download.suggestedFilename());
    await download.saveAs(savePath);
    console.log('下载成功:', savePath);
    try {
      await importBarrageToFeishu(savePath, '【小学】');
      console.log('飞书导入成功');
    } catch (e) {
      console.log('飞书导入失败:', e.message);
    }
  } finally {
    await context.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
