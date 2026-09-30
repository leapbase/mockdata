import { beforeEach, describe, expect, it, vi } from 'vitest';

const { verifyMock, sendMailMock } = vi.hoisted(() => ({
  verifyMock: vi.fn(),
  sendMailMock: vi.fn(),
}));

vi.mock('nodemailer', () => ({
  default: {
    createTransport: () => ({
      verify: verifyMock,
      sendMail: sendMailMock,
    }),
  },
}));

import { createMailer } from '../src/mailer.js';

beforeEach(() => {
  verifyMock.mockReset();
  sendMailMock.mockReset();
});

describe('createMailer', () => {
  it('isConfigured requires both host and from', () => {
    expect(createMailer({}).isConfigured()).toBe(false);
    expect(createMailer({ host: 'smtp.example.com' }).isConfigured()).toBe(false);
    expect(createMailer({ host: 'smtp.example.com', from: 'a@b.com' }).isConfigured()).toBe(true);
  });

  describe('verifyConnection', () => {
    it('rejects missing required configuration without connecting', async () => {
      await expect(createMailer({}).verifyConnection()).rejects.toThrow('SMTP is not configured: missing host, from');
      expect(verifyMock).not.toHaveBeenCalled();
    });

    it('rejects an invalid port before connecting', async () => {
      await expect(
        createMailer({ host: 'smtp.example.com', from: 'a@b.com', port: 70000 }).verifyConnection()
      ).rejects.toThrow('SMTP port must be a valid TCP port');
      expect(verifyMock).not.toHaveBeenCalled();
    });

    it('verifies the transport once required config is present', async () => {
      verifyMock.mockResolvedValue(true);
      await expect(
        createMailer({ host: 'smtp.example.com', from: 'a@b.com' }).verifyConnection()
      ).resolves.toBeUndefined();
      expect(verifyMock).toHaveBeenCalledOnce();
    });
  });

  it('send() delegates to the transport with the configured from address', async () => {
    const mailer = createMailer({ host: 'smtp.example.com', from: 'a@b.com' });
    await mailer.send({ to: 'x@y.com', subject: 'hi', html: '<p>hi</p>' });
    expect(sendMailMock).toHaveBeenCalledWith({ from: 'a@b.com', to: 'x@y.com', subject: 'hi', html: '<p>hi</p>' });
  });

  it('identifies and formats SMTP authentication failures without stack details', () => {
    const mailer = createMailer({});
    const err = {
      code: 'EAUTH',
      response: '535 Incorrect authentication data',
      responseCode: 535,
      command: 'AUTH PLAIN',
      stack: 'stack should not appear',
    };

    expect(mailer.isAuthError(err)).toBe(true);
    expect(mailer.formatError(err)).toBe('SMTP authentication failed (535): 535 Incorrect authentication data');
  });
});
