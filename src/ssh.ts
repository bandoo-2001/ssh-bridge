import { Client, type ConnectConfig, type ClientChannel } from 'ssh2';
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
}
