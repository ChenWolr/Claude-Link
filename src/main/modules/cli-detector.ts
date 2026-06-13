import { execFile, exec } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import type { CliDetectionResult } from '../../shared/types/cli';
import { getConfig, saveConfig } from './config-manager';

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);
let cachedResult: CliDetectionResult | null = null;

async function runVersion(command: string): Promise<CliDetectionResult | null> {
  // 1. Try execFile first (works on most platforms)
  try {
    const { stdout, stderr } = await execFileAsync(command, ['--version'], { timeout: 5000 });
    const version = (stdout || stderr).trim() || null;
    return { installed: true, path: command, version };
  } catch {
    // Fall through to shell-based fallback
  }

  // 2. Windows fallback: use cmd /c to resolve .cmd/.bat files via PATH
  if (process.platform === 'win32') {
    try {
      const { stdout, stderr } = await execAsync(`"${command}" --version`, { timeout: 5000 });
      const version = (stdout || stderr).trim() || null;
      return { installed: true, path: command, version };
    } catch {
      // Fall through
    }

    // 3. Try npx fallback
    try {
      const { stdout, stderr } = await execAsync(`npx ${command} --version`, { timeout: 5000 });
      const version = (stdout || stderr).trim() || null;
      return { installed: true, path: `npx ${command}`, version };
    } catch {
      // Fall through
    }
  }

  return null;
}

function candidatePaths(): string[] {
  const candidates: string[] = [];
  const home = os.homedir();

  if (process.platform === 'win32') {
    if (process.env.APPDATA) {
      candidates.push(path.join(process.env.APPDATA, 'npm', 'claude.cmd'));
    }
    if (process.env.LOCALAPPDATA) {
      candidates.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'claude', 'claude.exe'));
    }
    // Common npm global install locations on Windows
    candidates.push(path.join(home, 'AppData', 'Roaming', 'npm', 'claude.cmd'));
    candidates.push(path.join(home, 'AppData', 'Roaming', 'npm', 'claude'));
    candidates.push('C:\\Program Files\\nodejs\\claude.cmd');
    candidates.push('C:\\Program Files\\nodejs\\claude');
  } else {
    candidates.push('/usr/local/bin/claude');
    candidates.push(path.join(home, '.npm', 'bin', 'claude'));
    candidates.push(path.join(home, '.local', 'bin', 'claude'));
    candidates.push('/usr/bin/claude');
  }

  return candidates;
}

async function detectFromPath(cliPath: string | null): Promise<CliDetectionResult | null> {
  if (!cliPath) {
    return null;
  }

  if (!fs.existsSync(cliPath)) {
    return null;
  }

  return runVersion(cliPath);
}

export async function detectCli(force = false): Promise<CliDetectionResult> {
  if (cachedResult && !force) {
    return cachedResult;
  }

  const config = getConfig();
  const configured = await detectFromPath(config.cliPath);
  if (configured) {
    cachedResult = configured;
    saveConfig({ cliPath: configured.path, cliVersion: configured.version });
    return configured;
  }

  const fromPath = await runVersion('claude');
  if (fromPath) {
    cachedResult = fromPath;
    saveConfig({ cliPath: fromPath.path, cliVersion: fromPath.version });
    return fromPath;
  }

  for (const candidate of candidatePaths()) {
    const result = await detectFromPath(candidate);
    if (result) {
      cachedResult = result;
      saveConfig({ cliPath: result.path, cliVersion: result.version });
      return result;
    }
  }

  cachedResult = { installed: false, path: null, version: null };
  saveConfig({ cliVersion: null });
  return cachedResult;
}

export function getCachedCliStatus(): CliDetectionResult | null {
  return cachedResult;
}

export function forceRedetect(): Promise<CliDetectionResult> {
  return detectCli(true);
}
