/**
 * Pénzösszegek kezelése.
 *
 * Belül MINDIG egész forintban számolunk (number, safe integer). Lebegőpontos
 * forint nem létezik ebben a kódban.
 *
 * SumUp-specifikus eltérés: az ISO 4217 a HUF-ot 2 tizedesjegyűnek írja, a SumUp
 * viszont 0-t vár. A @sumup/sdk 0.2.0 típusdefiníciója (CreateReaderCheckoutRequest.total_amount.minor_unit):
 *   "For the currencies CLP, COP and HUF, the minor unit is 0."
 * Tehát 1000 Ft = { value: 1000, currency: "HUF", minor_unit: 0 }.
 */

export const HUF = "HUF" as const;
export const SUMUP_HUF_MINOR_UNIT = 0;

export interface SumUpMoney {
  value: number;
  currency: string;
  minor_unit: number;
}

export function assertWholeForint(amountHuf: number): void {
  if (!Number.isSafeInteger(amountHuf) || amountHuf <= 0) {
    throw new RangeError(`Az összegnek pozitív egész forintnak kell lennie, kapott: ${amountHuf}`);
  }
}

export function hufToSumUp(amountHuf: number): SumUpMoney {
  assertWholeForint(amountHuf);
  return { value: amountHuf, currency: HUF, minor_unit: SUMUP_HUF_MINOR_UNIT };
}

/** SumUp összegből egész forint. Bármilyen minor_unit-ot elfogad, de nem kerekít csendben. */
export function sumUpToHuf(money: SumUpMoney): number {
  if (money.currency !== HUF) {
    throw new RangeError(`Nem HUF összeg: ${money.currency}`);
  }
  const divisor = 10 ** money.minor_unit;
  if (money.value % divisor !== 0) {
    throw new RangeError(`Nem egész forint: ${money.value} (minor_unit=${money.minor_unit})`);
  }
  return money.value / divisor;
}

export function formatHuf(amountHuf: number): string {
  return `${amountHuf.toLocaleString("hu-HU")} Ft`;
}
