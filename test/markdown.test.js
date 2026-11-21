import test from 'node:test';
import assert from 'node:assert/strict';
import { Marked } from 'marked';
import createDOMPurify from 'dompurify';
import { JSDOM } from 'jsdom';
import { createMarkdownRenderer } from '../public/markdown.js';

const { window } = new JSDOM('');
const renderMarkdown = createMarkdownRenderer(Marked, createDOMPurify(window));
function render(source) {
  const container = window.document.createElement('div');
  container.innerHTML = renderMarkdown(source);
  return container;
}

test('renders Markdown blocks, inline formatting, tables and task lists', () => {
  const el = render('# 題目\n\n**粗體**與*斜體*、~~刪除~~、`code`\n\n- 第一項\n- 第二項\n\n> 提示\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n- [x] 已完成');
  assert.equal(el.querySelector('h1').textContent, '題目');
  assert.equal(el.querySelector('strong').textContent, '粗體');
  assert.equal(el.querySelector('em').textContent, '斜體');
  assert.equal(el.querySelector('del').textContent, '刪除');
  assert.equal(el.querySelector('code').textContent, 'code');
  assert.equal(el.querySelector('blockquote').textContent.trim(), '提示');
  assert.equal(el.querySelectorAll('tbody td').length, 2);
  const checkbox = el.querySelector('input');
  assert.equal(checkbox.type, 'checkbox');
  assert.equal(checkbox.checked, true);
  assert.equal(checkbox.disabled, true);
});

test('preserves ordinary line breaks and literal HTML and code examples', () => {
  assert.equal(render('第一行\n第二行').querySelectorAll('br').length, 1);
  const code = '<script>alert("test")</script>\n  <div>& value</div>';
  const el = render('```html\n' + code + '\n```');
  assert.equal(el.querySelector('pre code').textContent, code + '\n');
  assert.equal(el.querySelector('script'), null);
  const html = '<button data-action="logout">範例</button>';
  const raw = render(html);
  assert.equal(raw.textContent.trim(), html);
  assert.equal(raw.querySelector('button'), null);
});

test('blocks executable links, raw HTML, handlers, app actions and DOM clobbering', () => {
  const el = render('[惡意](javascript:alert%281%29)\n\n[編碼](jav&#x61;script:alert%281%29)\n\n![圖片](javascript:alert%281%29)\n\n<img src=x onerror="alert(1)">\n\n<svg onload="alert(1)"></svg>\n\n<form id="app"><input name="answer" data-action="submit-attempt"></form>');
  assert.equal(el.querySelector('script, svg, form, [onerror], [onload], [data-action], [id], [name]'), null);
  assert.equal(el.querySelector('a[href], img[src]'), null);
});

test('keeps safe links, relative URLs and images, with safe navigation attributes', () => {
  const el = render('[文件](https://example.com/docs "說明") [站內](/example-questions.csv)\n\n![示意圖](https://example.com/diagram.png "圖片")');
  for (const link of el.querySelectorAll('a')) {
    assert.equal(link.target, '_blank');
    assert.equal(link.rel, 'noopener noreferrer');
  }
  assert.equal(el.querySelector('a').getAttribute('href'), 'https://example.com/docs');
  assert.equal(el.querySelector('img').alt, '示意圖');
  assert.equal(el.querySelector('img').getAttribute('loading'), 'lazy');
  assert.equal(el.querySelector('img').getAttribute('referrerpolicy'), 'no-referrer');
});

test('handles empty and maximum-length content without truncating Markdown', () => {
  assert.equal(renderMarkdown(null), '');
  const text = '題'.repeat(49996);
  assert.equal(render(`**${text}**`).querySelector('strong').textContent, text);
});
