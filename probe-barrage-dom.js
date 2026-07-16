#!/usr/bin/env node
/**
 * 探测中控台评论面板 DOM，定位弹幕导出按钮
 */
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { launchBrowser, waitForLogin } = require('./browser');

const LIVE_ID = process.argv[2] || '607413';
const OUT_DIR = path.join(__dirname, 'screenshots');

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const { context, page } = await launchBrowser();

  try {
    const loggedIn = await waitForLogin(page, { skipLogin: true });
    if (!loggedIn) throw new Error('未登录');

    const url = `https://live.pili-live.com/livestream/toLive?id=${LIVE_ID}&enterprise_id=3112`;
    console.log('打开中控台:', url);
    await page.goto(url, { timeout: config.navigationTimeout });
    await page.waitForTimeout(4000);
    await page.screenshot({ path: path.join(OUT_DIR, `probe-${LIVE_ID}-initial.png`) });

    const probe = await page.evaluate(() => {
      const result = {
        dialogs: [],
        chatPanels: [],
        exportCandidates: [],
        footerButtons: [],
      };

      document.querySelectorAll('.el-dialog__wrapper').forEach((el, i) => {
        const style = window.getComputedStyle(el);
        const visible = style.display !== 'none' && style.visibility !== 'hidden';
        result.dialogs.push({
          index: i,
          visible,
          title: (el.querySelector('.el-dialog__title')?.textContent || '').trim(),
          text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120),
        });
      });

      document.querySelectorAll('.chat').forEach((chat, ci) => {
        const html = chat.innerHTML.slice(0, 4000);
        result.chatPanels.push({ index: ci, className: chat.className, htmlSnippet: html });

        chat.querySelectorAll('.footer-t-btn, img.footer-t-icon, span').forEach((el) => {
          const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
          if (
            text.includes('导出') ||
            text.includes('暖场') ||
            el.classList.contains('footer-t-btn') ||
            el.classList.contains('footer-t-icon')
          ) {
            result.footerButtons.push({
              tag: el.tagName,
              className: el.className,
              text: text.slice(0, 80),
              outer: el.outerHTML.slice(0, 300),
            });
          }
        });
      });

      const patterns = ['导出所有评论消息', '暖场', 'footer-t-btn', 'footer-t-icon'];
      for (const pat of patterns) {
        const nodes = [...document.querySelectorAll('*')].filter((el) => {
          const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
          return t.includes(pat) || [...el.classList].some((c) => c.includes(pat));
        });
        for (const el of nodes.slice(0, 12)) {
          result.exportCandidates.push({
            pattern: pat,
            tag: el.tagName,
            className: el.className,
            text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 100),
            outer: el.outerHTML.slice(0, 400),
          });
        }
      }

      return result;
    });

    const outPath = path.join(OUT_DIR, `probe-${LIVE_ID}-dom.json`);
    fs.writeFileSync(outPath, JSON.stringify(probe, null, 2));
    console.log('DOM 探测结果:', outPath);
    console.log('弹窗:', probe.dialogs);
    console.log('footer 按钮:', probe.footerButtons);
    console.log('导出候选:', probe.exportCandidates.filter((x) => x.pattern === '导出所有评论消息'));

    // 逐个点击 footer-t-btn 看会打开什么（仅探测，不导出）
    const btnCount = await page.locator('.chat .footer-t-btn').count();
    console.log(`\n.chat .footer-t-btn 共 ${btnCount} 个，逐个探测:`);
    for (let i = 0; i < btnCount; i++) {
      const btn = page.locator('.chat .footer-t-btn').nth(i);
      const meta = await btn.evaluate((el) => ({
        className: el.className,
        html: el.outerHTML.slice(0, 300),
        parentText: (el.parentElement?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 100),
      }));
      console.log(`\n--- footer-t-btn[${i}] ---`);
      console.log(meta);

      // 关闭已有弹窗
      for (let j = 0; j < 3; j++) {
        const close = page.locator('.el-dialog__wrapper .el-dialog__headerbtn').first();
        if (await close.isVisible({ timeout: 300 }).catch(() => false)) {
          await close.click();
          await page.waitForTimeout(500);
        }
      }

      await btn.click();
      await page.waitForTimeout(1500);
      const dialogTitle = await page.locator('.el-dialog__wrapper .el-dialog__title').first()
        .textContent().catch(() => '');
      console.log(`点击后弹窗标题: ${(dialogTitle || '').trim() || '(无)'}`);
      await page.screenshot({ path: path.join(OUT_DIR, `probe-${LIVE_ID}-click-${i}.png`) });

      const close = page.locator('.el-dialog__wrapper .el-dialog__headerbtn').first();
      if (await close.isVisible({ timeout: 500 }).catch(() => false)) {
        await close.click();
        await page.waitForTimeout(500);
      }
    }
  } finally {
    await context.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
