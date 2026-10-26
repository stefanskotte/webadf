import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CopyInviteButtons } from './copy-invite-buttons';

describe('CopyInviteButtons look and linkLabel (C6 spec §4.2, §4.3, Ruling 18)', () => {
  it("a row's pair: 30 px, transparent, Copy code / Copy link, ids with the code", () => {
    const html = renderToStaticMarkup(createElement(CopyInviteButtons, { code: 'ABCD2345' }));
    expect(html).toContain('data-testid="invite-copy-code-ABCD2345"');
    expect(html).toContain('data-testid="invite-copy-link-ABCD2345"');
    expect(html).toContain('>Copy code</button>');
    expect(html).toContain('>Copy link</button>');
    expect(html.match(/h-\[30px\]/g)?.length).toBe(2);
  });
  it("the panel's pair: 38 px outline buttons, Copy sign-up link, ids without the code", () => {
    const html = renderToStaticMarkup(createElement(CopyInviteButtons, {
      code: 'ABCD2345', idPrefix: 'new-invite-copy', look: 'button', linkLabel: 'Copy sign-up link',
    }));
    expect(html).toContain('data-testid="new-invite-copy-code"');
    expect(html).toContain('data-testid="new-invite-copy-link"');
    expect(html).toContain('>Copy sign-up link</button>');
    expect(html.match(/h-\[38px\]/g)?.length).toBe(2);
    expect(html).toContain('border-(--line)');
  });
});
