// Кнопка «✦ AI» в поле ответа на комментарий на youtube.com: пишет черновик, отправляете вы сами.
(() => {
  const MARK = 'tc-ai-btn';

  const textOf = (el) => (el?.innerText || '').trim();

  function context(box) {
    const comment = box.closest('ytd-comment-view-model, ytd-comment-renderer');
    if (!comment) return null; // поле нового комментария под видео — не ответ
    const thread = box.closest('ytd-comment-thread-renderer');
    const root = thread?.querySelector('#comment #content-text, ytd-comment-view-model #content-text');
    const own = comment.querySelector('#content-text');
    return {
      comment: textOf(own),
      author: textOf(comment.querySelector('#author-text')),
      parentText: root && root !== own ? textOf(root) : '',
      videoTitle: textOf(document.querySelector('ytd-watch-metadata h1, h1.ytd-watch-metadata')) || document.title.replace(/ - YouTube$/, ''),
    };
  }

  function insert(box, text) {
    const input = box.querySelector('#contenteditable-root');
    if (!input) return;
    input.focus();
    document.execCommand('selectAll', false);
    // insertText проходит через обработчики YouTube — кнопка «Ответить» становится активной
    document.execCommand('insertText', false, text);
  }

  function addButton(box) {
    if (box.querySelector('.' + MARK)) return;
    const buttons = box.querySelector('#buttons');
    if (!buttons || !context(box)) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = MARK;
    btn.textContent = '✦ AI';
    btn.title = 'Написать ответ с помощью TubeComment';
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const ctx = context(box);
      if (!ctx?.comment) return;
      btn.disabled = true;
      btn.textContent = '✦ Пишу…';
      btn.classList.remove('tc-error');
      try {
        const r = await chrome.runtime.sendMessage({ type: 'compose', ...ctx });
        if (!r?.ok) throw new Error(r?.error || 'Расширение не ответило');
        insert(box, r.data);
        btn.textContent = '✦ Ещё вариант';
      } catch (err) {
        btn.textContent = '✦ Ошибка';
        btn.title = err.message;
        btn.classList.add('tc-error');
      } finally {
        btn.disabled = false;
      }
    });
    buttons.prepend(btn);
  }

  let pending = false;
  const scan = () => {
    pending = false;
    document.querySelectorAll('ytd-commentbox').forEach(addButton);
  };
  new MutationObserver(() => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(scan);
  }).observe(document.documentElement, { childList: true, subtree: true });
})();
