import { createHash, timingSafeEqual } from 'node:crypto';

const MODES = Object.freeze({
  quick: { model: 'gpt-6-luna', effort: 'none', maxOutput: 900, search: true },
  search: { model: 'gpt-6-sol', effort: 'low', maxOutput: 1400, search: true, requireSearch: true },
  expert: { model: 'gpt-6-sol', effort: 'medium', maxOutput: 1800, search: true },
  deep: { model: 'gpt-6-astra', effort: 'high', maxOutput: 2400, search: true },
});

const INSTRUCTIONS = `你是面向个人投资者的中文研究助手。回答应清楚地区分已核实的事实、你的分析和仍不确定的部分。不要编造股价、涨跌幅、财报数字、公告日期、消息来源或模型并未取得的数据。涉及当前行情或新闻时，若没有取得可信来源和时间戳，明确说明无法确认；不要把网页信息称为交易所实时行情。给出可能影响判断的风险和需要进一步核实的事项。可以解释投资思路，但不要给出保证收益的承诺，也不要替用户执行交易。优先简洁回答用户实际问题。`;

const ALLOWED_ORIGINS = new Set(['https://dachong0421.github.io']);

function json(data, status = 200, origin = '') {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  };
  if (ALLOWED_ORIGINS.has(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers.Vary = 'Origin';
  }
  return new Response(JSON.stringify(data), { status, headers });
}

function validAccessCode(value, expected) {
  if (!value || !expected) return false;
  const actualHash = createHash('sha256').update(value).digest();
  const expectedHash = createHash('sha256').update(expected).digest();
  return timingSafeEqual(actualHash, expectedHash);
}

async function readJsonWithLimit(request, limit = 8192) {
  const reader = request.body?.getReader();
  if (!reader) return null;
  const chunks = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > limit) {
      await reader.cancel();
      throw new Error('too_large');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

function collectAnswer(result) {
  const parts = [];
  const citations = [];
  let offset = 0;
  for (const item of result.output ?? []) {
    if (item.type !== 'message') continue;
    for (const content of item.content ?? []) {
      if (content.type !== 'output_text' || !content.text) continue;
      if (parts.length) offset += 2;
      parts.push(content.text);
      for (const note of content.annotations ?? []) {
        if (note.type !== 'url_citation' || !/^https?:\/\//i.test(note.url ?? '')) continue;
        citations.push({
          url: note.url,
          title: note.title || note.url,
          start: Number.isInteger(note.start_index) ? offset + note.start_index : null,
          end: Number.isInteger(note.end_index) ? offset + note.end_index : null,
        });
      }
      offset += content.text.length;
    }
  }
  return { answer: parts.join('\n\n'), citations };
}

export default {
  async fetch(request) {
    const origin = request.headers.get('origin') ?? '';
    if (request.method === 'OPTIONS') {
      if (!ALLOWED_ORIGINS.has(origin)) return new Response(null, { status: 403 });
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': origin,
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, X-Site-Access',
          'Access-Control-Max-Age': '600',
          Vary: 'Origin',
        },
      });
    }
    if (request.method === 'GET') {
      return json({ ready: Boolean(process.env.OPENAI_API_KEY && process.env.SITE_ACCESS_TOKEN) }, 200, origin);
    }
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, origin);
    if (!process.env.OPENAI_API_KEY || !process.env.SITE_ACCESS_TOKEN) {
      return json({ error: '服务尚未配置完成。' }, 503, origin);
    }
    if (!validAccessCode(request.headers.get('x-site-access'), process.env.SITE_ACCESS_TOKEN)) {
      return json({ error: '访问码无效，请重新输入。', code: 'invalid_access' }, 401, origin);
    }

    let data;
    try {
      data = await readJsonWithLimit(request);
    } catch {
      return json({ error: '请求格式无效或内容过长。' }, 400, origin);
    }
    const prompt = typeof data?.question === 'string' ? data.question.trim() : '';
    const mode = Object.hasOwn(MODES, data?.mode) ? MODES[data.mode] : null;
    if (!prompt || prompt.length > 2000 || !mode) {
      return json({ error: '请输入不超过 2000 字的问题，并选择有效模式。' }, 400, origin);
    }

    const payload = {
      model: mode.model,
      reasoning: { effort: mode.effort },
      instructions: INSTRUCTIONS + (mode.search ? ' 对涉及最新资讯的问题先使用网页搜索；引用来源并说明信息发布时间或查询时间。' : ' 本模式没有联网搜索；不要暗示你掌握最新行情。'),
      input: prompt,
      max_output_tokens: mode.maxOutput,
      store: false,
    };
    if (mode.search) payload.tools = [{ type: 'web_search' }];
    if (mode.requireSearch) payload.tool_choice = 'required';

    let upstream;
    try {
      upstream = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(55_000),
      });
    } catch {
      return json({ error: 'AI 服务暂时无法连接，请稍后重试。' }, 502, origin);
    }

    if (!upstream.ok) {
      let providerError = {};
      try {
        providerError = (await upstream.json()).error ?? {};
      } catch {
        // An upstream error can have an empty or non-JSON body.
      }
      const providerCode = typeof providerError.code === 'string' ? providerError.code : '';
      if (upstream.status === 429) {
        if (providerCode === 'insufficient_quota') {
          return json({ error: 'OpenAI API 账户额度不足，请检查 API 账单和用量上限。', code: providerCode }, 429, origin);
        }
        if (providerCode === 'rate_limit_exceeded') {
          return json({ error: '触发了 OpenAI API 的速率限制，请稍后重试。', code: providerCode }, 429, origin);
        }
        return json({ error: 'OpenAI API 返回了 429，请检查账户额度或稍后重试。', code: providerCode || 'upstream_429' }, 429, origin);
      }
      if (providerCode === 'model_not_found') {
        return json({ error: '当前 API 项目无法使用所选模型。', code: providerCode }, 502, origin);
      }
      if (upstream.status === 401 || upstream.status === 403) return json({ error: 'AI 服务授权失败，请联系站点管理员。', code: providerCode || 'upstream_auth' }, 502, origin);
      return json({ error: 'AI 服务暂时无法完成分析，请稍后重试。', code: providerCode || 'upstream_error' }, 502, origin);
    }

    let result;
    try {
      result = await upstream.json();
    } catch {
      return json({ error: 'AI 服务返回的数据无法读取。' }, 502, origin);
    }
    const { answer, citations } = collectAnswer(result);
    if (!answer) return json({ error: 'AI 服务没有返回可显示的分析。' }, 502, origin);
    return json({ answer, citations, model: mode.model, searched: (result.output ?? []).some((item) => item.type === 'web_search_call'), generatedAt: new Date().toISOString() }, 200, origin);
  },
};
