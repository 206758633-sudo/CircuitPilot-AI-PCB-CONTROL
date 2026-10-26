/**
 * E3 / R10：下单参数卡人工确认 + 支付人工留痕（只记录，不代下单、不代付）。
 *
 * 为什么单独一条证据：R10 在能力表里是 Human + 政策红线——系统只能出参数卡，
 * 下单动作与支付必须由人完成。这里记录的是"人在什么参数卡上、以什么身份、
 * 什么时候确认了什么"，同时把"支付不由系统执行"写成 payload 的硬事实，
 * 防止下游把"已确认参数"误读成"已下单/已支付"。
 *
 * fail-closed：
 *   - 参数卡必须是 `readyToOrder:true` 的卡（不能确认一张自己都判"不能下单"的卡）；
 *   - 确认人必填；必须显式勾选"本系统不代下单/不代付"的声明；
 *   - 不接收"帮我下单/帮我付款"字段，也不返回任何下单/支付能力。
 */
export const ORDER_CONFIRMATION_CODES = Object.freeze({
  INPUT_INVALID: 'ORDER_CONFIRMATION_INPUT_INVALID',
  BLOCKED: 'ORDER_CONFIRMATION_BLOCKED',
});

const text = (value) => String(value ?? '').trim();

/** @throws {Error & {code:string,status:number}} */
export function validateOrderConfirmation({ card, operator, note = '', paymentManual = false } = {}) {
  if (!card || typeof card !== 'object' || Array.isArray(card)) {
    throw Object.assign(new Error('缺少下单参数卡对象：必须先在本机生成并核对参数卡'), { code: ORDER_CONFIRMATION_CODES.INPUT_INVALID, status: 400 });
  }
  if (card.readyToOrder !== true) {
    const blocking = Number(card?.counts?.blocking) || 0;
    const unknown = Number(card?.counts?.unknown) || 0;
    throw Object.assign(new Error(`参数卡当前不可下单（${blocking} 条阻断 / ${unknown} 条未确认）：先把参数卡修到 readyToOrder=true 再人工确认`), { code: ORDER_CONFIRMATION_CODES.BLOCKED, status: 409, details: { readyToOrder: false, counts: card?.counts ?? null } });
  }
  const who = text(operator);
  if (!who) throw Object.assign(new Error('确认人必填：下单确认是人工行为，必须留痕'), { code: ORDER_CONFIRMATION_CODES.INPUT_INVALID, status: 400 });
  if (paymentManual !== true) throw Object.assign(new Error('必须显式声明"下单/支付由人完成、系统不代付"（paymentManual=true）'), { code: ORDER_CONFIRMATION_CODES.INPUT_INVALID, status: 400 });
  if (text(card?.price?.status) === 'known' && !card?.price?.source) {
    throw Object.assign(new Error('参数卡价格标为已知但没有来源：不能确认一份来路不明的价格'), { code: ORDER_CONFIRMATION_CODES.BLOCKED, status: 409 });
  }
  return {
    operator: who,
    note: text(note).slice(0, 1000) || null,
    paymentManual: true,
    acknowledged: {
      orderExecutedBySystem: false,
      paymentExecutedBySystem: false,
      humanExecutor: who,
    },
    card: {
      generatedAt: card.generatedAt ?? null,
      readyToOrder: true,
      counts: card.counts ?? null,
      parameters: card.parameters ?? null,
      price: card.price ?? null,
      humanSignoffRequired: card.humanSignoffRequired === true,
      files: Array.isArray(card.files) ? card.files.map((file) => ({ kind: file?.kind ?? null, name: file?.name ?? null, draft: file?.draft === true })).slice(0, 50) : [],
    },
  };
}
