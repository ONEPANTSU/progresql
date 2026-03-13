import { readFileSync, writeFileSync } from 'fs';

// ===== DatabasePanel.tsx =====
const dbFile = '/Users/onepantsu/Desktop/progresql/progresql-client/renderer/components/DatabasePanel.tsx';
let db = readFileSync(dbFile, 'utf8');

db = "import { useTranslation } from '../contexts/LanguageContext';\n" + db;

db = db.replace(
  'const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);',
  'const { t } = useTranslation();\n  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);'
);

const dbReplacements = [
  [/title="Connect to this database"/g, 'title={t("db.connect")}'],
  [/title="Retry connection"/g, 'title={t("db.retry")}'],
  [/aria-label="Retry connection"/g, 'aria-label={t("db.retry")}'],
  [/title="Add New Connection"/g, 'title={t("db.addConnection")}'],
  [/title="Analyze Schema"/g, 'title={t("db.analyzeSchema")}'],
  [/title="Refresh Database Structure"/g, 'title={t("db.refresh")}'],
  ["secondary={isConnecting ? 'Connecting...' : undefined}", "secondary={isConnecting ? t('db.connecting') : undefined}"],
  [/(<ListItemIcon><CopyIcon[^/]*\/><\/ListItemIcon>\n\s*)Copy Name/g, '$1{t("db.copyName")}'],
  [/(<ListItemIcon><InfoIcon[^/]*\/><\/ListItemIcon>\n\s*)View Info/g, '$1{t("db.viewInfo")}'],
  [/(<ListItemIcon><CodeIcon[^/]*\/><\/ListItemIcon>\n\s*)View Source/g, '$1{t("db.viewSource")}'],
  [/(<ListItemIcon><ViewIcon[^/]*\/><\/ListItemIcon>\n\s*)Insert Name/g, '$1{t("db.insertName")}'],
  [/(<ListItemIcon><FunctionIcon[^/]*\/><\/ListItemIcon>\n\s*)Insert Name/g, '$1{t("db.insertName")}'],
  [/(<ListItemIcon><ProcedureIcon[^/]*\/><\/ListItemIcon>\n\s*)Insert Name/g, '$1{t("db.insertName")}'],
  [/(<ListItemIcon><AnalyzeIcon[^/]*\/><\/ListItemIcon>\n\s*)Explain/g, '$1{t("db.explainAI")}'],
  [/(<ListItemIcon><RefreshIcon[^/]*\/><\/ListItemIcon>\n\s*)Refresh/g, '$1{t("db.refresh")}'],
];

for (const [search, replace] of dbReplacements) {
  if (typeof search === 'string') {
    db = db.replace(search, replace);
  } else {
    db = db.replace(search, replace);
  }
}

writeFileSync(dbFile, db);
console.log('DatabasePanel.tsx done');

// ===== QueryResults.tsx =====
const qrFile = '/Users/onepantsu/Desktop/progresql/progresql-client/renderer/components/QueryResults.tsx';
let qr = readFileSync(qrFile, 'utf8');

qr = "import { useTranslation } from '../contexts/LanguageContext';\n" + qr;

qr = qr.replace(
  'const [page, setPage] = useState(0);',
  'const { t } = useTranslation();\n  const [page, setPage] = useState(0);'
);

// rows chip
qr = qr.replace(
  "label={`${result.rowCount} rows`}",
  "label={t('results.rows', { count: String(result.rowCount) })}"
);

// Add Row button
qr = qr.replace(
  /(\s*)Add Row/,
  '$1{t("results.addRow")}'
);

// Delete confirmation title
qr = qr.replace(
  /<DialogTitle>Delete {selectedRows.size} Row{selectedRows.size > 1 \? 's' : ''}<\/DialogTitle>/,
  "<DialogTitle>{t('results.deleteConfirmTitle')}</DialogTitle>"
);

// Delete confirmation text
qr = qr.replace(
  /<DialogContentText>\n\s*Are you sure you want to delete {selectedRows.size} selected row{selectedRows.size > 1 \? 's' : ''}\? This action cannot be undone.\n\s*<\/DialogContentText>/,
  "<DialogContentText>\n            {t('results.deleteConfirmText')}\n          </DialogContentText>"
);

// Cancel button
qr = qr.replace(
  '<Button onClick={() => setDeleteConfirm(false)}>Cancel</Button>',
  "<Button onClick={() => setDeleteConfirm(false)}>{t('results.cancel')}</Button>"
);

// Delete button
qr = qr.replace(
  '<Button onClick={handleDeleteSelected} color="error" variant="contained">\n            Delete\n          </Button>',
  '<Button onClick={handleDeleteSelected} color="error" variant="contained">\n            {t("results.delete")}\n          </Button>'
);

writeFileSync(qrFile, qr);
console.log('QueryResults.tsx done');
