import React from 'react';
import type { AppProps } from 'next/app';
import Head from 'next/head';
import CssBaseline from '@mui/material/CssBaseline';
import { Box } from '@mui/material';
import { AuthProvider } from '../providers/AuthProvider';
import { NotificationProvider } from '../contexts/NotificationContext';
import { ThemeProvider } from '../contexts/ThemeContext';
import { AgentProvider } from '../contexts/AgentContext';
import { LanguageProvider } from '../contexts/LanguageContext';
import NotificationBridge from '../components/NotificationBridge';
import '../styles/sidebar.css';

export default function App({ Component, pageProps }: AppProps) {
  return (
    <LanguageProvider>
    <ThemeProvider>
      <Head>
        <title>ProgreSQL</title>
      </Head>
      <CssBaseline />
      <style jsx global>{`
        /* Light theme styles for CodeMirror editor */
        .light-editor .cm-editor {
          background-color: #ffffff !important;
          color: #000000 !important;
        }

        .light-editor .cm-content {
          background-color: #ffffff !important;
          color: #000000 !important;
        }

        .light-editor .cm-focused .cm-content {
          background-color: #ffffff !important;
        }

        .light-editor .cm-gutters {
          background-color: #f5f5f5 !important;
          color: #666666 !important;
          border-right: 1px solid #e0e0e0 !important;
        }

        .light-editor .cm-activeLineGutter {
          background-color: #e8e8e8 !important;
        }

        .light-editor .cm-activeLine {
          background-color: #f8f8f8 !important;
        }

        /* All possible selection styles for light theme */
        .light-editor .cm-selectionBackground,
        .light-editor .cm-focused .cm-selectionBackground,
        .light-editor .cm-editor .cm-selectionBackground,
        .light-editor .cm-editor.cm-focused .cm-selectionBackground,
        .light-editor .cm-content .cm-selectionBackground,
        .light-editor .cm-content.cm-focused .cm-selectionBackground,
        .light-editor .cm-selection,
        .light-editor .cm-focused .cm-selection,
        .light-editor .cm-editor .cm-selection,
        .light-editor .cm-editor.cm-focused .cm-selection,
        .light-editor .cm-content .cm-selection,
        .light-editor .cm-content.cm-focused .cm-selection,
        .light-editor .cm-editor .cm-selectionBackground,
        .light-editor .cm-editor.cm-focused .cm-selectionBackground,
        .light-editor .cm-scroller .cm-selectionBackground,
        .light-editor .cm-scroller .cm-selection,
        .light-editor .cm-line .cm-selectionBackground,
        .light-editor .cm-line .cm-selection {
          background-color: #6366f1 !important;
          color: #ffffff !important;
        }

        /* Alternative selection styles */
        .light-editor .cm-editor ::selection,
        .light-editor .cm-content ::selection,
        .light-editor .cm-scroller ::selection {
          background-color: #6366f1 !important;
          color: #ffffff !important;
        }

        .light-editor .cm-cursor {
          border-left-color: #000000 !important;
        }

        .light-editor .cm-dropCursor {
          border-left-color: #000000 !important;
        }

        /* Remove borders and shadows from CodeMirror */
        .light-editor .cm-editor,
        .light-editor .cm-content,
        .light-editor .cm-scroller,
        .light-editor .cm-editor .cm-content,
        .light-editor .cm-editor .cm-scroller {
          border: none !important;
          outline: none !important;
          box-shadow: none !important;
        }

        /* Remove any bottom border or line */
        .light-editor .cm-editor::after,
        .light-editor .cm-content::after,
        .light-editor .cm-scroller::after {
          display: none !important;
        }

        /* Syntax highlighting for light theme */
        .light-editor .cm-keyword {
          color: #0000ff !important;
        }

        .light-editor .cm-string {
          color: #008000 !important;
        }

        .light-editor .cm-comment {
          color: #808080 !important;
          font-style: italic !important;
        }

        .light-editor .cm-number {
          color: #ff8000 !important;
        }

        .light-editor .cm-operator {
          color: #000000 !important;
        }

        .light-editor .cm-function {
          color: #0000ff !important;
        }

        .light-editor .cm-variable {
          color: #000000 !important;
        }

        .light-editor .cm-type {
          color: #800080 !important;
        }

        .light-editor .cm-bracket {
          color: #000000 !important;
        }

        .light-editor .cm-punctuation {
          color: #000000 !important;
        }
      `}</style>
      <AuthProvider>
        <AgentProvider>
          <NotificationProvider>
            <NotificationBridge />
            <Box sx={{ height: '100vh', overflow: 'hidden' }}>
              <Component {...pageProps} />
            </Box>
          </NotificationProvider>
        </AgentProvider>
      </AuthProvider>
    </ThemeProvider>
    </LanguageProvider>
  );
}
