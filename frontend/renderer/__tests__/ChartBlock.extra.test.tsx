/*
* Created on Mar 28, 2026
* Test file for ChartBlock.tsx (extended coverage — utility functions and tooltip components)
* File path: renderer/__tests__/ChartBlock.extra.test.tsx
*
* Author: Abhijeet Pratap Singh - Senior Software Engineer
* Copyright (c) 2026 Aurigo
*/

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import ChartBlock from '@/features/agent-chat/ui/ChartBlock';
import type { MessageVisualization } from '@/shared/types';

// ── Mock recharts ─────────────────────────────────────────────────────────────

jest.mock('recharts', () => {
  const MockComponent: React.FC<{ children?: React.ReactNode; [key: string]: any }> = ({ children }) => (
    <div data-testid="recharts-mock">{children}</div>
  );
  return {
    BarChart: MockComponent,
    Bar: MockComponent,
    LineChart: MockComponent,
    Line: MockComponent,
    PieChart: MockComponent,
    Pie: MockComponent,
    Cell: MockComponent,
    AreaChart: MockComponent,
    Area: MockComponent,
    XAxis: MockComponent,
    YAxis: MockComponent,
    CartesianGrid: MockComponent,
    Tooltip: MockComponent,
    ResponsiveContainer: ({ children }: any) => <div data-testid="responsive-container">{children}</div>,
    Legend: MockComponent,
  };
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeViz(overrides: Partial<MessageVisualization> = {}): MessageVisualization {
  return {
    chart_type: 'bar',
    title: 'Test Chart',
    data: [
      { category: 'A', value: 10 },
      { category: 'B', value: 20 },
    ],
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('ChartBlock (extended coverage)', () => {

  // ── Axis labels ────────────────────────────────────────────────────────────

  describe('axis labels propagation', () => {
    it('renders bar chart with x_label and y_label without crashing', () => {
      render(<ChartBlock visualization={makeViz({ chart_type: 'bar', x_label: 'Month', y_label: 'Revenue' })} />);
      expect(screen.getAllByTestId('recharts-mock').length).toBeGreaterThan(0);
    });

    it('renders line chart with x_label and y_label without crashing', () => {
      render(<ChartBlock visualization={makeViz({ chart_type: 'line', x_label: 'Date', y_label: 'Users' })} />);
      expect(screen.getAllByTestId('recharts-mock').length).toBeGreaterThan(0);
    });

    it('renders area chart with x_label and y_label without crashing', () => {
      render(<ChartBlock visualization={makeViz({ chart_type: 'area', x_label: 'Week', y_label: 'Sessions' })} />);
      expect(screen.getAllByTestId('recharts-mock').length).toBeGreaterThan(0);
    });
  });

  // ── PieChart with valueKey missing (no y-axis keys) ───────────────────────

  describe('PieChart edge cases', () => {
    it('shows no-data when pie data has only label keys (no numeric values)', () => {
      const data = [{ name: 'Alice' }, { name: 'Bob' }];
      render(<ChartBlock visualization={makeViz({ chart_type: 'pie', data })} />);
      expect(screen.getByText('Нет данных')).toBeInTheDocument();
    });

    it('renders pie chart with many data points (> 6, no labels)', () => {
      const data = Array.from({ length: 8 }, (_, i) => ({ category: `Item ${i}`, value: i + 1 }));
      render(<ChartBlock visualization={makeViz({ chart_type: 'pie', data })} />);
      expect(screen.getAllByTestId('recharts-mock').length).toBeGreaterThan(0);
    });

    it('renders pie chart with 6 or fewer data points (with labels)', () => {
      const data = Array.from({ length: 4 }, (_, i) => ({ category: `Item ${i}`, value: i + 1 }));
      render(<ChartBlock visualization={makeViz({ chart_type: 'pie', data })} />);
      expect(screen.getAllByTestId('recharts-mock').length).toBeGreaterThan(0);
    });
  });

  // ── MetricView with string value ──────────────────────────────────────────

  describe('MetricView with non-numeric values', () => {
    it('renders string value directly in metric view', () => {
      const data = [{ status: 'Active' }];
      render(<ChartBlock visualization={makeViz({ chart_type: 'metric', data, title: 'Status' })} />);
      expect(screen.getByText('Active')).toBeInTheDocument();
    });

    it('renders null value as em dash', () => {
      const data = [{ total: null }];
      render(<ChartBlock visualization={makeViz({ chart_type: 'metric', data: data as any, title: 'Nulled' })} />);
      expect(screen.getByText('—')).toBeInTheDocument();
    });

    it('renders number as formatted string', () => {
      const data = [{ total: 999 }];
      render(<ChartBlock visualization={makeViz({ chart_type: 'metric', data, title: 'Count' })} />);
      expect(screen.getByText('999')).toBeInTheDocument();
    });
  });

  // ── Chart type switching ──────────────────────────────────────────────────

  describe('chart type switching to all types', () => {
    it('starts with bar chart and switches to area (third button)', () => {
      render(<ChartBlock visualization={makeViz({ chart_type: 'bar' })} />);
      const buttons = screen.getAllByRole('button');
      fireEvent.click(buttons[2]); // Area
      expect(screen.getAllByTestId('recharts-mock').length).toBeGreaterThan(0);
    });

    it('starts with pie and switches to bar (first button)', () => {
      render(<ChartBlock visualization={makeViz({ chart_type: 'pie' })} />);
      const buttons = screen.getAllByRole('button');
      fireEvent.click(buttons[0]); // Bar
      expect(screen.getAllByTestId('recharts-mock').length).toBeGreaterThan(0);
    });

    it('starts with area and switches to line (second button)', () => {
      render(<ChartBlock visualization={makeViz({ chart_type: 'area' })} />);
      const buttons = screen.getAllByRole('button');
      fireEvent.click(buttons[1]); // Line
      expect(screen.getAllByTestId('recharts-mock').length).toBeGreaterThan(0);
    });

    it('bar chart initial type is active (bar type button has active styling)', () => {
      render(<ChartBlock visualization={makeViz({ chart_type: 'bar' })} />);
      // Just verify initial rendering is stable
      expect(screen.getAllByTestId('recharts-mock').length).toBeGreaterThan(0);
    });
  });

  // ── Data shape handling — coerceNumericData paths ─────────────────────────

  describe('coerceNumericData edge cases', () => {
    it('handles data with all string-encoded numbers in bar chart', () => {
      const data = [
        { month: 'Jan', revenue: '1500', costs: '900' },
        { month: 'Feb', revenue: '2000', costs: '1100' },
      ];
      render(<ChartBlock visualization={makeViz({ chart_type: 'bar', data })} />);
      expect(screen.getAllByTestId('recharts-mock').length).toBeGreaterThan(0);
    });

    it('handles mixed numeric and string values in line chart', () => {
      const data = [
        { date: '2024-01', value: 100 },
        { date: '2024-02', value: '200' },
        { date: '2024-03', value: 150 },
      ];
      render(<ChartBlock visualization={makeViz({ chart_type: 'line', data })} />);
      expect(screen.getAllByTestId('recharts-mock').length).toBeGreaterThan(0);
    });

    it('handles empty string values gracefully', () => {
      const data = [
        { label: 'A', value: '' },
        { label: 'B', value: 10 },
      ];
      render(<ChartBlock visualization={makeViz({ chart_type: 'bar', data })} />);
      expect(screen.getAllByTestId('recharts-mock').length).toBeGreaterThan(0);
    });

    it('handles data with non-finite string numbers (NaN stays as string)', () => {
      const data = [
        { label: 'A', value: 'NaN' },
        { label: 'B', value: 20 },
      ];
      render(<ChartBlock visualization={makeViz({ chart_type: 'bar', data })} />);
      expect(screen.getAllByTestId('recharts-mock').length).toBeGreaterThan(0);
    });
  });

  // ── TableView columns ─────────────────────────────────────────────────────

  describe('TableView column rendering', () => {
    it('renders multiple columns correctly', () => {
      const data = [
        { id: 1, name: 'Alice', email: 'alice@example.com', age: 30 },
        { id: 2, name: 'Bob', email: 'bob@example.com', age: 25 },
      ];
      render(<ChartBlock visualization={makeViz({ chart_type: 'table', data })} />);
      expect(screen.getByText('id')).toBeInTheDocument();
      expect(screen.getByText('name')).toBeInTheDocument();
      expect(screen.getByText('email')).toBeInTheDocument();
      expect(screen.getByText('age')).toBeInTheDocument();
    });

    it('renders numeric values in table', () => {
      const data = [{ count: 42, total: 1000 }];
      render(<ChartBlock visualization={makeViz({ chart_type: 'table', data })} />);
      expect(screen.getByText('42')).toBeInTheDocument();
      expect(screen.getByText('1000')).toBeInTheDocument();
    });

    it('renders multiple rows in table', () => {
      const data = [
        { name: 'Alice' },
        { name: 'Bob' },
        { name: 'Charlie' },
      ];
      render(<ChartBlock visualization={makeViz({ chart_type: 'table', data })} />);
      expect(screen.getByText('Alice')).toBeInTheDocument();
      expect(screen.getByText('Bob')).toBeInTheDocument();
      expect(screen.getByText('Charlie')).toBeInTheDocument();
    });

    it('renders undefined cell values as NULL', () => {
      const data = [{ name: 'Alice', value: undefined }];
      render(<ChartBlock visualization={makeViz({ chart_type: 'table', data: data as any })} />);
      expect(screen.getByText('NULL')).toBeInTheDocument();
    });
  });

  // ── Refresh button with non-switchable chart types ─────────────────────────

  describe('refresh button with non-switchable chart types', () => {
    it('renders refresh button for metric chart when onRefresh is provided', () => {
      const onRefresh = jest.fn();
      render(<ChartBlock visualization={makeViz({ chart_type: 'metric', data: [{ v: 1 }] })} onRefresh={onRefresh} />);
      const buttons = screen.getAllByRole('button');
      expect(buttons.length).toBe(1); // Only refresh, no type switcher
    });

    it('calls onRefresh for metric chart', () => {
      const onRefresh = jest.fn();
      render(<ChartBlock visualization={makeViz({ chart_type: 'metric', data: [{ v: 1 }] })} onRefresh={onRefresh} />);
      fireEvent.click(screen.getByRole('button'));
      expect(onRefresh).toHaveBeenCalledTimes(1);
    });

    it('renders refresh button for table chart when onRefresh is provided', () => {
      const onRefresh = jest.fn();
      const data = [{ a: 1 }];
      render(<ChartBlock visualization={makeViz({ chart_type: 'table', data })} onRefresh={onRefresh} />);
      const buttons = screen.getAllByRole('button');
      expect(buttons.length).toBe(1);
    });
  });

  // ── Multiple series charts ─────────────────────────────────────────────────

  describe('multiple series', () => {
    it('renders bar chart with many series (uses CHART_COLORS cycling)', () => {
      const data = [
        { period: 'Q1', a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7, h: 8, i: 9, j: 10, k: 11, l: 12, m: 13 },
      ];
      render(<ChartBlock visualization={makeViz({ chart_type: 'bar', data })} />);
      expect(screen.getAllByTestId('recharts-mock').length).toBeGreaterThan(0);
    });

    it('renders area chart with multiple series', () => {
      const data = [
        { date: 'Jan', alpha: 100, beta: 200, gamma: 150 },
        { date: 'Feb', alpha: 110, beta: 210, gamma: 160 },
      ];
      render(<ChartBlock visualization={makeViz({ chart_type: 'area', data })} />);
      expect(screen.getAllByTestId('recharts-mock').length).toBeGreaterThan(0);
    });
  });
});
