import { InputFile } from 'grammy';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChannelMessage } from '../channel.js';
import { TelegramAdapter } from '../channels/telegram.js';

function makeMsg(overrides: Partial<ChannelMessage> = {}): ChannelMessage {
  return {
    channelType: 'telegram',
    senderId: '100',
    senderName: 'alice',
    chatId: '42',
    chatType: 'dm',
    text: 'hello',
    messageId: '7',
    raw: {},
    ...overrides,
  };
}

function makeAdapter(api: Record<string, unknown>): TelegramAdapter {
  const adapter = new TelegramAdapter({ botToken: 'test-token' });
  (adapter as any).bot = { api };
  (adapter as any).inputFileCtor = InputFile;
  return adapter;
}

describe('TelegramAdapter outbound reliability', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('sends HTML replies with quote reply metadata', async () => {
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 101 }),
    };
    const adapter = makeAdapter(api);

    await adapter.reply(makeMsg(), '**hello**');

    expect(api.sendMessage).toHaveBeenCalledWith(42, '<b>hello</b>', {
      parse_mode: 'HTML',
      reply_to_message_id: 7,
    });
  });

  it('falls back to plain text when Telegram rejects HTML entities', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const api = {
      sendMessage: vi
        .fn()
        .mockRejectedValueOnce({
          error_code: 400,
          description: "Bad Request: can't parse entities: unsupported start tag",
        })
        .mockResolvedValueOnce({ message_id: 102 }),
    };
    const adapter = makeAdapter(api);

    await adapter.reply(makeMsg(), '**hello**');

    expect(api.sendMessage).toHaveBeenNthCalledWith(1, 42, '<b>hello</b>', {
      parse_mode: 'HTML',
      reply_to_message_id: 7,
    });
    expect(api.sendMessage).toHaveBeenNthCalledWith(2, 42, '**hello**', {
      reply_to_message_id: 7,
    });
    expect(warnSpy.mock.calls.join(' ')).toContain('fallback=plain');
    expect(warnSpy.mock.calls.join(' ')).not.toContain('test-token');
  });

  it('falls back to a normal chat message when reply target is stale', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const api = {
      sendMessage: vi
        .fn()
        .mockRejectedValueOnce({
          error_code: 400,
          description: 'Bad Request: replied message not found',
        })
        .mockResolvedValueOnce({ message_id: 103 }),
    };
    const adapter = makeAdapter(api);

    await adapter.reply(makeMsg(), 'hello');

    expect(api.sendMessage).toHaveBeenNthCalledWith(1, 42, 'hello', {
      parse_mode: 'HTML',
      reply_to_message_id: 7,
    });
    expect(api.sendMessage).toHaveBeenNthCalledWith(2, 42, 'hello', {
      parse_mode: 'HTML',
    });
    expect(warnSpy.mock.calls.join(' ')).toContain('fallback=no-reply');
  });

  it('retries once after Telegram rate limits the send', async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const api = {
      sendMessage: vi
        .fn()
        .mockRejectedValueOnce({
          error_code: 429,
          description: 'Too Many Requests: retry after 1',
          parameters: { retry_after: 1 },
        })
        .mockResolvedValueOnce({ message_id: 104 }),
    };
    const adapter = makeAdapter(api);

    const promise = adapter.send('42', 'hello');
    await vi.advanceTimersByTimeAsync(1000);
    await promise;

    expect(api.sendMessage).toHaveBeenCalledTimes(2);
    expect(warnSpy.mock.calls.join(' ')).toContain('retry=rate-limit');
  });

  it('logs sanitized metadata when all send attempts fail', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = {
      error_code: 400,
      description: 'Bad Request: forbidden',
    };
    const api = {
      sendMessage: vi.fn().mockRejectedValue(error),
    };
    const adapter = makeAdapter(api);

    await expect(adapter.send('42', 'secret prompt body')).rejects.toBe(error);

    const log = warnSpy.mock.calls.join(' ');
    expect(log).toContain('failed');
    expect(log).toContain('chat=42');
    expect(log).not.toContain('secret prompt body');
    expect(log).not.toContain('test-token');
  });

  it('creates and clears temporary status messages without HTML parsing', async () => {
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 105 }),
      deleteMessage: vi.fn().mockResolvedValue(true),
    };
    const adapter = makeAdapter(api);

    const statusId = await adapter.sendStatus(makeMsg(), '⏳ thinking...');
    await adapter.clearStatus(makeMsg(), statusId);

    expect(statusId).toBe('105');
    expect(api.sendMessage).toHaveBeenCalledWith(42, '⏳ thinking...', {
      reply_to_message_id: 7,
    });
    expect(api.deleteMessage).toHaveBeenCalledWith(42, 105);
  });
});

describe('TelegramAdapter sendMedia', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends an image via sendPhoto with reply metadata', async () => {
    const api = {
      sendPhoto: vi.fn().mockResolvedValue({ message_id: 201 }),
    };
    const adapter = makeAdapter(api);

    await adapter.sendMedia(makeMsg(), {
      kind: 'image',
      data: Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]),
      fileName: 'cam0.jpg',
    });

    expect(api.sendPhoto).toHaveBeenCalledTimes(1);
    const [chatId, input, options] = api.sendPhoto.mock.calls[0];
    expect(chatId).toBe(42);
    expect(input).toBeInstanceOf(InputFile);
    expect(input.filename).toBe('cam0.jpg');
    expect(options).toEqual({ reply_to_message_id: 7 });
  });

  it('sends a file via sendDocument', async () => {
    const api = {
      sendDocument: vi.fn().mockResolvedValue({ message_id: 202 }),
    };
    const adapter = makeAdapter(api);

    await adapter.sendMedia(makeMsg(), {
      kind: 'file',
      data: Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]),
      fileName: 'report.pdf',
    });

    expect(api.sendDocument).toHaveBeenCalledTimes(1);
    const [chatId, input, options] = api.sendDocument.mock.calls[0];
    expect(chatId).toBe(42);
    expect(input.filename).toBe('report.pdf');
    expect(options).toEqual({ reply_to_message_id: 7 });
  });

  it('falls back to default filenames when none is provided', async () => {
    const api = {
      sendPhoto: vi.fn().mockResolvedValue({ message_id: 203 }),
      sendDocument: vi.fn().mockResolvedValue({ message_id: 204 }),
    };
    const adapter = makeAdapter(api);

    await adapter.sendMedia(makeMsg(), {
      kind: 'image',
      data: Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]),
    });
    await adapter.sendMedia(makeMsg(), {
      kind: 'file',
      data: Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]),
    });

    expect(api.sendPhoto.mock.calls[0][1].filename).toBe('image.jpg');
    expect(api.sendDocument.mock.calls[0][1].filename).toBe('attachment.bin');
  });

  it('rejects media smaller than the platform minimum', async () => {
    const api = {
      sendPhoto: vi.fn(),
    };
    const adapter = makeAdapter(api);

    await expect(adapter.sendMedia(makeMsg(), { kind: 'image', data: Buffer.from([1, 2]) })).rejects.toThrow(
      'Media too small',
    );

    expect(api.sendPhoto).not.toHaveBeenCalled();
  });

  it('rejects media larger than the platform maximum', async () => {
    const api = {};
    const adapter = makeAdapter(api);
    const big = Buffer.alloc(10 * 1024 * 1024 + 1);

    await expect(adapter.sendMedia(makeMsg(), { kind: 'image', data: big })).rejects.toThrow('Media too large');
    const bigFile = Buffer.alloc(20 * 1024 * 1024 + 1);
    await expect(adapter.sendMedia(makeMsg(), { kind: 'file', data: bigFile })).rejects.toThrow('Media too large');
  });

  it('throws a sanitized error when Telegram rejects the upload', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const api = {
      sendPhoto: vi.fn().mockRejectedValue({
        error_code: 400,
        description: 'Bad Request: PHOTO_INVALID_DIMENSIONS',
      }),
    };
    const adapter = makeAdapter(api);

    await expect(
      adapter.sendMedia(makeMsg(), {
        kind: 'image',
        data: Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]),
        fileName: 'cam0.jpg',
      }),
    ).rejects.toThrow('Failed to send image: 400:Bad Request:');

    const log = warnSpy.mock.calls.join(' ');
    expect(log).toContain('chat=42');
    expect(log).toContain('cam0.jpg');
    expect(log).not.toContain('test-token');
  });
});
