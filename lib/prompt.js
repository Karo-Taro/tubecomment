// Промпт для ответа на комментарий. Голос канала задаётся на вкладке «Голос».

export const TONES = {
  friendly: 'дружелюбно и тепло',
  expert: 'по делу, как эксперт в теме видео',
  funny: 'с лёгким юмором',
  short: 'очень коротко, одной фразой',
  formal: 'вежливо и сдержанно, на «вы»',
  casual: 'неформально, на «ты»',
};

export function buildSystem(voice, rules, channel, { allowSkip }) {
  const lines = [
    `Ты отвечаешь на комментарии под видео от имени автора YouTube-канала${channel?.title ? ` «${channel.title}»` : ''}.`,
    'Пиши как живой человек — автор канала, а не ассистент. Никогда не упоминай, что ты ИИ, модель или бот.',
  ];
  if (voice.persona?.trim()) lines.push('О канале и авторе:\n' + voice.persona.trim());
  const tones = (voice.tone || []).map((t) => TONES[t]).filter(Boolean);
  if (tones.length) lines.push('Тон: ' + tones.join(', ') + '.');
  lines.push(voice.language && voice.language !== 'auto'
    ? `Отвечай на языке: ${voice.language}.`
    : 'Отвечай на том же языке, на котором написан комментарий.');
  lines.push(`Длина ответа — не больше ${voice.maxChars || 280} символов.`);
  lines.push(voice.emoji ? 'Эмодзи можно, но не больше одного-двух.' : 'Без эмодзи.');
  if (voice.signature?.trim()) lines.push(`Заканчивай ответ подписью: ${voice.signature.trim()}`);
  if (voice.avoid?.trim()) lines.push('Никогда не делай и не обсуждай: ' + voice.avoid.trim());
  lines.push('Не придумывай факты о видео, которых нет в названии или описании. Не давай ссылок и не обещай того, чего автор не обещал.');
  if (voice.examples?.trim()) lines.push('Примеры прошлых ответов автора — повторяй их стиль:\n' + voice.examples.trim());
  if (allowSkip) {
    lines.push(
      'Если комментарий — спам, реклама, оскорбление, провокация или на него нечего ответить по существу, ответ не нужен.',
      'Верни строго JSON без пояснений: {"reply": "текст ответа"} или {"skip": true, "reason": "коротко почему"}.',
    );
  } else {
    lines.push('Верни только текст ответа, без кавычек и пояснений.');
  }
  return lines.join('\n\n');
}

export function buildUser({ videoTitle, videoDescription, author, text, parentText }) {
  const parts = [];
  if (videoTitle) parts.push(`Видео: «${videoTitle}»`);
  if (videoDescription) parts.push(`Описание видео (начало): ${videoDescription.slice(0, 600)}`);
  if (parentText) parts.push(`Исходный комментарий ветки: ${parentText}`);
  parts.push(`Комментарий от ${author || 'зрителя'}:\n${text}`);
  return parts.join('\n\n');
}

// Обрезает ответ до лимита по границе предложения или слова
export function clampReply(text, max) {
  let s = String(text || '').trim().replace(/^["«]|["»]$/g, '').trim();
  if (!max || s.length <= max) return s;
  const cut = s.slice(0, max);
  const sentence = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  if (sentence > max * 0.5) return cut.slice(0, sentence + 1);
  return cut.slice(0, cut.lastIndexOf(' ') > 0 ? cut.lastIndexOf(' ') : max).trim() + '…';
}
