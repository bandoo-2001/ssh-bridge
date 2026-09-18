import { readFile } from 'node:fs/promises';
import YAML from 'yaml';
import { z } from 'zod';

const ServerSchema = z.object({
  name: z.string().optional(), host: z.string(), port: z.number().int().positive().default(22),
  username: z.string(), privateKey: z.string().optional(), passphrase: z.string().optional(), password: z.string().optional()
}).refine((server) => Boolean(server.privateKey || server.password), { message: 'privateKey 和 password 至少配置一个' });
const ConfigSchema = z.object({ servers: z.record(z.string(), ServerSchema) });
export type ServerConfig = z.infer<typeof ServerSchema>;

export async function loadConfig(path = process.env.SSH_BRIDGE_CONFIG ?? 'servers.yaml') {
  const raw = YAML.parse(await readFile(path, 'utf8'));
  return ConfigSchema.parse(raw).servers;
}
