import { Client, type ConnectConfig, type ClientChannel, type SFTPWrapper, type Stats } from 'ssh2';
import { readFile } from 'node:fs/promises';
import type { ServerConfig } from './config.js';

export class SshManager {
  async connect(config: ServerConfig) {
    const conn = new Client();
    const options: ConnectConfig = { host: config.host, port: config.port, username: config.username, passphrase: config.passphrase };
    if (config.privateKey) options.privateKey = await readFile(config.privateKey);
    else if (config.password) options.password = config.password;
    await new Promise<void>((resolve, reject) => { conn.once('ready', () => resolve()).once('error', reject).connect(options); });
    return conn;
  }
  exec(conn: Client, command: string, onData: (stream: 'stdout' | 'stderr', data: Buffer) => void, onClose: (code: number | null) => void) {
    return new Promise<ClientChannel>((resolve, reject) => conn.exec(command, (error, channel) => {
      if (error) return reject(error);
      channel.on('data', (data: Buffer) => onData('stdout', data));
      channel.stderr.on('data', (data: Buffer) => onData('stderr', data));
      channel.once('close', (code: number | null) => onClose(code));
      resolve(channel);
    }));
  }
  shell(conn: Client, cols: number, rows: number) {
    return new Promise<ClientChannel>((resolve, reject) => conn.shell({ term: 'xterm-256color', cols, rows }, (error, channel) => error ? reject(error) : resolve(channel)));
  }
  sftp(conn: Client) {
    return new Promise<SFTPWrapper>((resolve, reject) => conn.sftp((error, sftp) => error ? reject(error) : resolve(sftp)));
  }
  stat(sftp: SFTPWrapper, path: string) {
    return new Promise<Stats>((resolve, reject) => sftp.stat(path, (error, stats) => error ? reject(error) : resolve(stats)));
  }
  readdir(sftp: SFTPWrapper, path: string) {
    return new Promise<import('ssh2').FileEntry[]>((resolve, reject) => sftp.readdir(path, (error, list) => error ? reject(error) : resolve(list)));
  }
  read(sftp: SFTPWrapper, path: string, offset: number, maxBytes: number) {
    return new Promise<{ data: Buffer; bytesRead: number }>((resolve, reject) => {
      sftp.open(path, 'r', (openError, handle) => {
        if (openError) return reject(openError);
        const buffer = Buffer.alloc(maxBytes);
        sftp.read(handle, buffer, 0, maxBytes, offset, (readError, bytesRead) => {
          sftp.close(handle, () => undefined);
          if (readError) return reject(readError);
          resolve({ data: buffer.subarray(0, bytesRead), bytesRead });
        });
      });
    });
  }

  // Read from one handle and wait for CLOSE before the caller ends the connection.
  async readCompleteFile(sftp: SFTPWrapper, path: string, maxBytes: number): Promise<Buffer> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
      throw new Error('maxBytes must be a positive safe integer');
    }
    const handle = await new Promise<Buffer>((resolve, reject) =>
      sftp.open(path, 'r', (error, value) => error ? reject(error) : resolve(value)));
    const statHandle = () => new Promise<Stats>((resolve, reject) =>
      sftp.fstat(handle, (error, stats) => error ? reject(error) : resolve(stats)));
    let completed = false;
    try {
      const before = await statHandle();
      if (!before.isFile()) throw new Error('Path is not a regular file');
      if (!Number.isSafeInteger(before.size) || before.size <= 0) {
        throw new Error('Image is empty or has an invalid size');
      }
      if (before.size > maxBytes) {
        throw new Error(`Image exceeds ${maxBytes} bytes; use a smaller image or format=base64 for chunked reading`);
      }
      const data = Buffer.alloc(before.size);
      let offset = 0;
      while (offset < data.length) {
        const requested = Math.min(64 * 1024, data.length - offset);
        const bytesRead = await new Promise<number>((resolve, reject) =>
          sftp.read(handle, data, offset, requested, offset,
            (error, count) => error ? reject(error) : resolve(count)));
        if (!Number.isSafeInteger(bytesRead) || bytesRead <= 0 || bytesRead > requested) {
          throw new Error('Unexpected EOF or invalid read length: image is incomplete');
        }
        offset += bytesRead;
      }
      const after = await statHandle();
      if (after.size !== before.size || after.mtime !== before.mtime || !after.isFile()) {
        throw new Error('File changed while reading; capture the image again and retry');
      }
      completed = true;
      return data;
    } finally {
      try {
        await new Promise<void>((resolve, reject) =>
          sftp.close(handle, error => error ? reject(error) : resolve()));
      } catch (closeError) {
        // Preserve the original read error; surface a close error on successful reads.
        if (completed) throw closeError;
      }
    }
  }
}
