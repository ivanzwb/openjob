export const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'out',
  'build',
  '.next',
  'target',
  '__pycache__',
  '.venv',
  'vendor',
]);

export const TEXT_EXT = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.java', '.kt',
  '.c', '.cpp', '.h', '.hpp', '.cs', '.rb', '.php', '.swift', '.md',
  '.json', '.yaml', '.yml', '.toml', '.sql', '.sh', '.vue', '.svelte',
]);

export const MAX_FILE_BYTES = 512_000;
export const MAX_SNAPSHOT_FILES = 1500;
export const MAX_SNAPSHOT_TOTAL_BYTES = 30_000_000;
