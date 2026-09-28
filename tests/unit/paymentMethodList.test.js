'use strict';

// Which payment-method lists a merchant may save: each id must be a method the
// gateway integration really takes (Paymob and Kashier: card and wallet), and
// at most one gateway may take each method.

const { methodListProblems } = require('../../src/modules/payments/paymentMethodsService');
const gateways = require('../../src/modules/payments/gateways');

const fields = (methods) => methodListProblems(methods).map((p) => p.field);

describe('methodListProblems', () => {
  it('knows what each integration supports', () => {
    expect(gateways.getAdapter('paymob').methods).toEqual(['card', 'wallet']);
    expect(gateways.getAdapter('kashier').methods).toEqual(['card', 'wallet']);
  });

  it('accepts COD and the integrations’ own methods', () => {
    expect(
      methodListProblems([
        { id: 'cod', enabled: true },
        { id: 'paymob:card', enabled: true },
        { id: 'kashier:wallet', enabled: true },
        { id: 'kashier:card', enabled: false },
      ])
    ).toEqual([]);
  });

  it('refuses a method no integration offers', () => {
    expect(fields([{ id: 'paymob:installments', enabled: true }])).toEqual(['methods.0.id']);
    expect(fields([{ id: 'fawry:kiosk', enabled: false }])).toEqual(['methods.0.id']);
    expect(fields([{ id: 'valu', enabled: true }])).toEqual(['methods.0.id']);
  });

  it('refuses a method listed twice', () => {
    expect(fields([{ id: 'cod', enabled: true }, { id: 'cod', enabled: false }])).toEqual(['methods.1.id']);
  });

  it('refuses two gateways switched on for the same method', () => {
    expect(
      fields([
        { id: 'paymob:card', enabled: true },
        { id: 'kashier:card', enabled: true },
      ])
    ).toEqual(['methods.1.enabled']);
  });
});
