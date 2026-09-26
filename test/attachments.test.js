import './helpers/env.js';
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { fakes, resetFakes } from './helpers/fakes.js';
import { db } from '../src/db.js';
import { streamAttachment } from '../src/admin/support.js';

beforeEach(resetFakes);

const MB = 1024 * 1024;

// Вложение входящего письма; возвращает id вложения в базе
function attachment({ size, withLength }) {
    const emailId = `email${Math.random().toString(36).slice(2)}`;
    const threadId = Number(db.prepare("INSERT INTO support_threads (email, subject, subject_norm) VALUES ('c@test.local', 'x', 'x')").run().lastInsertRowid);
    const msgId = Number(db.prepare("INSERT INTO support_messages (thread_id, direction, resend_id) VALUES (?, 'in', ?)").run(threadId, emailId).lastInsertRowid);
    fakes.resend.attachments.set(`${emailId}/att1`, { size, withLength });
    // Размер в метаданных неизвестен — проверка до скачивания не срабатывает
    return Number(db.prepare("INSERT INTO support_attachments (message_id, resend_attachment_id, filename) VALUES (?, 'att1', 'file.bin')").run(msgId).lastInsertRowid);
}

// Ответ Express в миниатюре: считает полученные байты
class FakeRes extends Writable {
    bytes = 0;
    headers = {};
    set(h, v) {
        if (typeof h === 'string') this.headers[h] = v;
        else Object.assign(this.headers, h);
        return this;
    }
    _write(chunk, _enc, cb) {
        this.bytes += chunk.length;
        cb();
    }
}

test('обычное вложение отдаётся целиком как файл', async () => {
    const res = new FakeRes();
    await streamAttachment(attachment({ size: 3 * MB, withLength: true }), res);
    assert.equal(res.bytes, 3 * MB);
    assert.equal(res.headers['Content-Type'], 'application/octet-stream');
    assert.match(res.headers['Content-Disposition'], /^attachment;/);
});

test('больше 25 МБ по Content-Length — отказ до скачивания', async () => {
    const res = new FakeRes();
    await assert.rejects(streamAttachment(attachment({ size: 26 * MB, withLength: true }), res), /больше 25 МБ/);
    assert.equal(res.bytes, 0);
});

test('больше 25 МБ без Content-Length — передача обрывается на лимите', async () => {
    const res = new FakeRes();
    await assert.rejects(streamAttachment(attachment({ size: 40 * MB, withLength: false }), res), /больше 25 МБ/);
    assert.ok(res.bytes <= 25 * MB, `передано ${res.bytes} байт`);
});

test('без Content-Length, но в пределах лимита — отдаётся целиком', async () => {
    const res = new FakeRes();
    await streamAttachment(attachment({ size: 5 * MB, withLength: false }), res);
    assert.equal(res.bytes, 5 * MB);
});
