// Re-export the shared Claude Code settings parser so main-process callers
// (config-manager) and the renderer apply identical extraction rules.
export { parseClaudeSettings, type ImportedSettings } from '../../shared/settings-parser';
