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
}
