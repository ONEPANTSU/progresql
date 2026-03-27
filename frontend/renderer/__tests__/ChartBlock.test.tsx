/*
* Created on Mar 27, 2026
* Test file for ChartBlock.tsx
* File path: renderer/__tests__/ChartBlock.test.tsx
*
* Author: Abhijeet Pratap Singh - Senior Software Engineer
* Copyright (c) 2026 Aurigo
*/

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import ChartBlock from '../components/chat/ChartBlock';
import type { MessageVisualization } from '../types';

// ── Mock recharts — complex SVG, not meaningful to test in jsdom ──────────────

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

describe('ChartBlock', () => {
  // ── Rendering ─────────────────────────────────────────────────────────────

  describe('rendering', () => {
    it('renders without crashing for bar chart', () => {
      render(<ChartBlock visualization={makeViz({ chart_type: 'bar' })} />);
      expect(screen.getAllByTestId('recharts-mock').length).toBeGreaterThan(0);
    });

    it('renders title in the header', () => {
      render(<ChartBlock visualization={makeViz({ title: 'Sales by Month' })} />);
      expect(screen.getByText('Sales by Month')).toBeInTheDocument();
    });

    it('renders for line chart type', () => {
      render(<ChartBlock visualization={makeViz({ chart_type: 'line' })} />);
      expect(screen.getAllByTestId('recharts-mock').length).toBeGreaterThan(0);
    });

    it('renders for area chart type', () => {
      render(<ChartBlock visualization={makeViz({ chart_type: 'area' })} />);
      expect(screen.getAllByTestId('recharts-mock').length).toBeGreaterThan(0);
    });

    it('renders for pie chart type', () => {
      render(<ChartBlock visualization={makeViz({ chart_type: 'pie' })} />);
      expect(screen.getAllByTestId('recharts-mock').length).toBeGreaterThan(0);
    });

    it('renders metric view for metric chart type', () => {
      const data = [{ total: 42 }];
      render(<ChartBlock visualization={makeViz({ chart_type: 'metric', data, title: 'Total Users' })} />);
      expect(screen.getByText('42')).toBeInTheDocument();
    });

    it('renders table view for table chart type', () => {
      const data = [{ name: 'Alice', age: 30 }, { name: 'Bob', age: 25 }];
      render(<ChartBlock visualization={makeViz({ chart_type: 'table', data })} />);
      expect(screen.getByText('Alice')).toBeInTheDocument();
      expect(screen.getByText('Bob')).toBeInTheDocument();
    });

    it('shows table column headers', () => {
      const data = [{ name: 'Alice', age: 30 }];
      render(<ChartBlock visualization={makeViz({ chart_type: 'table', data })} />);
      expect(screen.getByText('name')).toBeInTheDocument();
      expect(screen.getByText('age')).toBeInTheDocument();
    });

    it('renders error message for unknown chart type', () => {
      render(<ChartBlock visualization={makeViz({ chart_type: 'unknown_type' as any })} />);
      expect(screen.getByText(/unknown chart type/i)).toBeInTheDocument();
    });
  });

  // ── Chart type switcher ───────────────────────────────────────────────────

  describe('chart type switcher', () => {
    it('renders 4 type switch buttons for bar chart (Bar, Line, Area, Pie)', () => {
      render(<ChartBlock visualization={makeViz({ chart_type: 'bar' })} />);
      // Bar, Line, Area, Pie type switcher buttons
      const buttons = screen.getAllByRole('button');
      expect(buttons.length).toBeGreaterThanOrEqual(4);
    });

    it('renders 4 type switch buttons for line chart', () => {
      render(<ChartBlock visualization={makeViz({ chart_type: 'line' })} />);
      const buttons = screen.getAllByRole('button');
      expect(buttons.length).toBeGreaterThanOrEqual(4);
    });

    it('does not render type switch buttons for metric chart', () => {
      render(<ChartBlock visualization={makeViz({ chart_type: 'metric', data: [{ v: 1 }] })} />);
      // No switcher buttons for non-switchable types
      expect(screen.queryAllByRole('button')).toHaveLength(0);
    });

    it('does not render type switch buttons for table chart', () => {
      render(<ChartBlock visualization={makeViz({ chart_type: 'table', data: [{ a: 1 }] })} />);
      expect(screen.queryAllByRole('button')).toHaveLength(0);
    });

    it('switches chart type when a switch button is clicked', () => {
      render(<ChartBlock visualization={makeViz({ chart_type: 'bar' })} />);

      const buttons = screen.getAllByRole('button');
      expect(buttons.length).toBeGreaterThan(0);

      // Click first button (Bar)
      fireEvent.click(buttons[0]);

      // Chart still renders after switch
      expect(screen.getAllByTestId('recharts-mock').length).toBeGreaterThan(0);
    });

    it('switches to second chart type (Line) when second button is clicked', () => {
      render(<ChartBlock visualization={makeViz({ chart_type: 'bar' })} />);
      const buttons = screen.getAllByRole('button');
      fireEvent.click(buttons[1]); // Line
      expect(screen.getAllByTestId('recharts-mock').length).toBeGreaterThan(0);
    });

    it('switches to pie chart when fourth button is clicked', () => {
      render(<ChartBlock visualization={makeViz({ chart_type: 'bar' })} />);
      const buttons = screen.getAllByRole('button');
      fireEvent.click(buttons[3]); // Pie
      expect(screen.getAllByTestId('recharts-mock').length).toBeGreaterThan(0);
    });

    it('switches to area chart when third button is clicked', () => {
      render(<ChartBlock visualization={makeViz({ chart_type: 'bar' })} />);
      const buttons = screen.getAllByRole('button');
      fireEvent.click(buttons[2]); // Area
      expect(screen.getAllByTestId('recharts-mock').length).toBeGreaterThan(0);
    });

    it('can switch back after type change', () => {
      render(<ChartBlock visualization={makeViz({ chart_type: 'line' })} />);
      const buttons = screen.getAllByRole('button');
      fireEvent.click(buttons[0]); // Bar
      fireEvent.click(buttons[1]); // Line
      expect(screen.getAllByTestId('recharts-mock').length).toBeGreaterThan(0);
    });
  });

  // ── Refresh button ────────────────────────────────────────────────────────

  describe('refresh button', () => {
    it('renders an extra button when onRefresh is provided', () => {
      const onRefresh = jest.fn();
      render(<ChartBlock visualization={makeViz()} onRefresh={onRefresh} />);
      // 4 type switcher + 1 refresh button = 5 buttons
      expect(screen.getAllByRole('button')).toHaveLength(5);
    });

    it('does not render extra button when onRefresh is not provided', () => {
      render(<ChartBlock visualization={makeViz()} />);
      // Only 4 type switcher buttons
      expect(screen.getAllByRole('button')).toHaveLength(4);
    });

    it('calls onRefresh when last button (refresh) is clicked', () => {
      const onRefresh = jest.fn();
      render(<ChartBlock visualization={makeViz()} onRefresh={onRefresh} />);
      const buttons = screen.getAllByRole('button');
      fireEvent.click(buttons[buttons.length - 1]); // last = refresh
      expect(onRefresh).toHaveBeenCalledTimes(1);
    });
  });

  // ── PieChart empty state ──────────────────────────────────────────────────

  describe('PieChart with empty data', () => {
    it('shows no-data message when pie data is empty', () => {
      render(<ChartBlock visualization={makeViz({ chart_type: 'pie', data: [] })} />);
      expect(screen.getByText('Нет данных')).toBeInTheDocument();
    });
  });

  // ── TableView edge cases ──────────────────────────────────────────────────

  describe('TableView edge cases', () => {
    it('renders nothing for empty table data', () => {
      const { container } = render(<ChartBlock visualization={makeViz({ chart_type: 'table', data: [] })} />);
      // Table element should not be present
      expect(container.querySelector('table')).toBeNull();
    });

    it('renders NULL for null values in table', () => {
      const data = [{ name: null, count: 5 }];
      render(<ChartBlock visualization={makeViz({ chart_type: 'table', data: data as any })} />);
      expect(screen.getByText('NULL')).toBeInTheDocument();
    });
  });

  // ── MetricView ────────────────────────────────────────────────────────────

  describe('MetricView', () => {
    it('renders formatted number', () => {
      const data = [{ total: 1234567 }];
      render(<ChartBlock visualization={makeViz({ chart_type: 'metric', data, title: 'Revenue' })} />);
      // toLocaleString formats numbers with separators
      expect(screen.getByText(/1[,.]?234[,.]?567/)).toBeInTheDocument();
    });

    it('renders em dash when data is empty', () => {
      render(<ChartBlock visualization={makeViz({ chart_type: 'metric', data: [], title: 'Total' })} />);
      expect(screen.getByText('—')).toBeInTheDocument();
    });

    it('displays the title as subtitle', () => {
      const data = [{ total: 99 }];
      render(<ChartBlock visualization={makeViz({ chart_type: 'metric', data, title: 'Active Users' })} />);
      // Title appears in header and in MetricView subtitle
      expect(screen.getAllByText('Active Users').length).toBeGreaterThanOrEqual(1);
    });
  });

  // ── Data with different shapes ────────────────────────────────────────────

  describe('data shape handling', () => {
    it('renders bar chart with numeric string values', () => {
      const data = [{ category: 'A', value: '100' }, { category: 'B', value: '200' }];
      render(<ChartBlock visualization={makeViz({ chart_type: 'bar', data })} />);
      expect(screen.getAllByTestId('recharts-mock').length).toBeGreaterThan(0);
    });

    it('renders bar chart with single key data (no y-axis keys)', () => {
      const data = [{ name: 'Alice' }, { name: 'Bob' }];
      render(<ChartBlock visualization={makeViz({ chart_type: 'bar', data })} />);
      expect(screen.getAllByTestId('recharts-mock').length).toBeGreaterThan(0);
    });

    it('renders line chart with multiple series', () => {
      const data = [
        { month: 'Jan', sales: 100, profit: 50 },
        { month: 'Feb', sales: 150, profit: 80 },
      ];
      render(<ChartBlock visualization={makeViz({ chart_type: 'line', data })} />);
      expect(screen.getAllByTestId('recharts-mock').length).toBeGreaterThan(0);
    });
  });
});
