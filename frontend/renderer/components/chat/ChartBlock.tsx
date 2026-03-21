import React, { useMemo } from 'react';
import { Box, Typography, IconButton, Tooltip } from '@mui/material';
import {
  Refresh as RefreshIcon,
} from '@mui/icons-material';
import {
  BarChart, Bar,
  LineChart, Line,
  PieChart, Pie, Cell,
  AreaChart, Area,
  XAxis, YAxis, CartesianGrid,
  Tooltip as RechartsTooltip,
  ResponsiveContainer,
  Legend,
} from 'recharts';
import type { MessageVisualization } from '../../types';

const CHART_COLORS = [
  '#6366f1', '#8b5cf6', '#a78bfa', '#c4b5fd',
  '#818cf8', '#7c3aed', '#5b21b6', '#4f46e5',
  '#4338ca', '#3730a3', '#312e81', '#6d28d9',
];

interface ChartBlockProps {
  visualization: MessageVisualization;
  onRefresh?: () => void;
}

/** Check whether a value is numeric (number or string that parses as a finite number). */
function isNumericValue(v: unknown): boolean {
  if (typeof v === 'number') return true;
  if (typeof v === 'string' && v.trim() !== '') return !isNaN(Number(v));
  return false;
}

/** Coerce string-encoded numbers in data rows to actual numbers so Recharts can plot them. */
function coerceNumericData(data: Record<string, unknown>[], numericKeys: string[]): Record<string, unknown>[] {
  if (numericKeys.length === 0) return data;
  return data.map(row => {
    const newRow = { ...row };
    for (const k of numericKeys) {
      if (typeof newRow[k] === 'string') {
        const n = Number(newRow[k]);
        if (isFinite(n)) newRow[k] = n;
      }
    }
    return newRow;
  });
}

function getDataKeys(data: Record<string, unknown>[]): { xKey: string; yKeys: string[] } {
  if (!data || data.length === 0) return { xKey: '', yKeys: [] };
  const keys = Object.keys(data[0]);
  // First key is typically the label/x-axis, rest are numeric values
  const xKey = keys[0] || '';
  const yKeys = keys.slice(1).filter(k => {
    return data.some(row => isNumericValue(row[k]));
  });
  return { xKey, yKeys: yKeys.length > 0 ? yKeys : keys.slice(1) };
}

const ChartHeader: React.FC<{
  title: string;
  onRefresh?: () => void;
}> = ({ title, onRefresh }) => (
  <Box sx={{
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    mb: 1,
  }}>
    <Typography variant="subtitle2" sx={{ fontWeight: 600, color: 'text.primary' }}>
      {title}
    </Typography>
    <Box sx={{ display: 'flex', gap: 0.5 }}>
      {onRefresh && (
        <Tooltip title="Refresh">
          <IconButton size="small" onClick={onRefresh} sx={{ color: 'text.secondary' }}>
            <RefreshIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      )}
    </Box>
  </Box>
);

const BarChartView: React.FC<{ data: Record<string, unknown>[]; xLabel?: string; yLabel?: string }> = ({ data, xLabel, yLabel }) => {
  const { xKey, yKeys, coercedData } = useMemo(() => {
    const keys = getDataKeys(data);
    return { ...keys, coercedData: coerceNumericData(data, keys.yKeys) };
  }, [data]);
  return (
    <ResponsiveContainer width="100%" height={280}>
      <BarChart data={coercedData} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
        <XAxis dataKey={xKey} tick={{ fill: '#9ca3af', fontSize: 12 }} label={xLabel ? { value: xLabel, position: 'insideBottom', offset: -5, fill: '#9ca3af' } : undefined} />
        <YAxis tick={{ fill: '#9ca3af', fontSize: 12 }} label={yLabel ? { value: yLabel, angle: -90, position: 'insideLeft', fill: '#9ca3af' } : undefined} />
        <RechartsTooltip cursor={false} contentStyle={{ backgroundColor: '#1f2937', border: '1px solid #374151', borderRadius: 8, color: '#e5e7eb' }} />
        <Legend />
        {yKeys.map((key, i) => (
          <Bar key={key} dataKey={key} fill={CHART_COLORS[i % CHART_COLORS.length]} radius={[4, 4, 0, 0]} activeBar={{ fillOpacity: 0.7 }} />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
};

const LineChartView: React.FC<{ data: Record<string, unknown>[]; xLabel?: string; yLabel?: string }> = ({ data, xLabel, yLabel }) => {
  const { xKey, yKeys, coercedData } = useMemo(() => {
    const keys = getDataKeys(data);
    return { ...keys, coercedData: coerceNumericData(data, keys.yKeys) };
  }, [data]);
  return (
    <ResponsiveContainer width="100%" height={280}>
      <LineChart data={coercedData} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
        <XAxis dataKey={xKey} tick={{ fill: '#9ca3af', fontSize: 12 }} label={xLabel ? { value: xLabel, position: 'insideBottom', offset: -5, fill: '#9ca3af' } : undefined} />
        <YAxis tick={{ fill: '#9ca3af', fontSize: 12 }} label={yLabel ? { value: yLabel, angle: -90, position: 'insideLeft', fill: '#9ca3af' } : undefined} />
        <RechartsTooltip contentStyle={{ backgroundColor: '#1f2937', border: '1px solid #374151', borderRadius: 8, color: '#e5e7eb' }} />
        <Legend />
        {yKeys.map((key, i) => (
          <Line key={key} type="monotone" dataKey={key} stroke={CHART_COLORS[i % CHART_COLORS.length]} strokeWidth={2} dot={{ r: 3 }} />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
};

const AreaChartView: React.FC<{ data: Record<string, unknown>[]; xLabel?: string; yLabel?: string }> = ({ data, xLabel, yLabel }) => {
  const { xKey, yKeys, coercedData } = useMemo(() => {
    const keys = getDataKeys(data);
    return { ...keys, coercedData: coerceNumericData(data, keys.yKeys) };
  }, [data]);
  return (
    <ResponsiveContainer width="100%" height={280}>
      <AreaChart data={coercedData} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
        <XAxis dataKey={xKey} tick={{ fill: '#9ca3af', fontSize: 12 }} label={xLabel ? { value: xLabel, position: 'insideBottom', offset: -5, fill: '#9ca3af' } : undefined} />
        <YAxis tick={{ fill: '#9ca3af', fontSize: 12 }} label={yLabel ? { value: yLabel, angle: -90, position: 'insideLeft', fill: '#9ca3af' } : undefined} />
        <RechartsTooltip contentStyle={{ backgroundColor: '#1f2937', border: '1px solid #374151', borderRadius: 8, color: '#e5e7eb' }} />
        <Legend />
        {yKeys.map((key, i) => (
          <Area key={key} type="monotone" dataKey={key} stroke={CHART_COLORS[i % CHART_COLORS.length]} fill={CHART_COLORS[i % CHART_COLORS.length]} fillOpacity={0.3} />
        ))}
      </AreaChart>
    </ResponsiveContainer>
  );
};

const PieChartView: React.FC<{ data: Record<string, unknown>[] }> = ({ data }) => {
  const { xKey, yKeys, coercedData } = useMemo(() => {
    const keys = getDataKeys(data);
    const coerced = coerceNumericData(data, keys.yKeys);
    return { ...keys, coercedData: coerced };
  }, [data]);
  const valueKey = yKeys[0] || '';

  if (!coercedData || coercedData.length === 0 || !valueKey) {
    return (
      <Box sx={{ textAlign: 'center', py: 4, color: 'text.secondary' }}>
        <Typography variant="body2">Нет данных</Typography>
      </Box>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={280}>
      <PieChart>
        <Pie
          data={coercedData}
          dataKey={valueKey}
          nameKey={xKey}
          cx="50%"
          cy="50%"
          outerRadius={100}
          label={({ name, percent }) => `${name}: ${((percent ?? 0) * 100).toFixed(0)}%`}
          labelLine={{ stroke: '#6b7280' }}
        >
          {coercedData.map((_, i) => (
            <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
          ))}
        </Pie>
        <RechartsTooltip contentStyle={{ backgroundColor: '#1f2937', border: '1px solid #374151', borderRadius: 8, color: '#e5e7eb' }} />
        <Legend />
      </PieChart>
    </ResponsiveContainer>
  );
};

const MetricView: React.FC<{ data: Record<string, unknown>[]; title: string }> = ({ data, title }) => {
  const value = data[0] ? Object.values(data[0])[0] : '—';
  const formattedValue = typeof value === 'number'
    ? value.toLocaleString()
    : String(value ?? '—');
  return (
    <Box sx={{ textAlign: 'center', py: 3 }}>
      <Typography variant="h3" sx={{ fontWeight: 700, color: '#6366f1', mb: 0.5 }}>
        {formattedValue}
      </Typography>
      <Typography variant="body2" sx={{ color: 'text.secondary' }}>
        {title}
      </Typography>
    </Box>
  );
};

const TableView: React.FC<{ data: Record<string, unknown>[] }> = ({ data }) => {
  if (!data || data.length === 0) return null;
  const columns = Object.keys(data[0]);
  return (
    <Box sx={{ overflowX: 'auto', maxHeight: 400 }}>
      <Box
        component="table"
        sx={{
          width: '100%',
          borderCollapse: 'collapse',
          fontSize: '0.8125rem',
          fontFamily: 'monospace',
        }}
      >
        <Box component="thead">
          <Box component="tr">
            {columns.map(col => (
              <Box
                key={col}
                component="th"
                sx={{
                  px: 1.5, py: 0.75,
                  textAlign: 'left',
                  fontWeight: 600,
                  whiteSpace: 'nowrap',
                  borderBottom: '2px solid #374151',
                  bgcolor: '#1f2937',
                  color: '#e5e7eb',
                  position: 'sticky',
                  top: 0,
                }}
              >
                {col}
              </Box>
            ))}
          </Box>
        </Box>
        <Box component="tbody">
          {data.map((row, rowIdx) => (
            <Box
              key={rowIdx}
              component="tr"
              sx={{ '&:hover': { bgcolor: 'rgba(99,102,241,0.08)' } }}
            >
              {columns.map(col => (
                <Box
                  key={col}
                  component="td"
                  sx={{
                    px: 1.5, py: 0.5,
                    borderBottom: '1px solid #374151',
                    color: '#d1d5db',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {String(row[col] ?? 'NULL')}
                </Box>
              ))}
            </Box>
          ))}
        </Box>
      </Box>
    </Box>
  );
};

const ChartBlock: React.FC<ChartBlockProps> = ({
  visualization,
  onRefresh,
}) => {
  const { chart_type, title, data, x_label, y_label } = visualization;

  const chartContent = useMemo(() => {
    switch (chart_type) {
      case 'bar':
        return <BarChartView data={data} xLabel={x_label} yLabel={y_label} />;
      case 'line':
        return <LineChartView data={data} xLabel={x_label} yLabel={y_label} />;
      case 'area':
        return <AreaChartView data={data} xLabel={x_label} yLabel={y_label} />;
      case 'pie':
        return <PieChartView data={data} />;
      case 'metric':
        return <MetricView data={data} title={title} />;
      case 'table':
        return <TableView data={data} />;
      default:
        return <Typography color="error">Unknown chart type: {chart_type}</Typography>;
    }
  }, [chart_type, data, title, x_label, y_label]);

  return (
    <Box sx={{
      my: 1.5,
      p: 2,
      borderRadius: 2,
      bgcolor: '#111827',
      border: '1px solid #1f2937',
      overflow: 'hidden',
    }}>
      <ChartHeader
        title={title}
        onRefresh={onRefresh}
      />
      {chartContent}
    </Box>
  );
};

export default ChartBlock;
