import React from 'react';
import ReactDOM from 'react-dom/client';
import '@fontsource-variable/ibm-plex-sans';
import '@fontsource/ibm-plex-mono/400.css';
import App from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { AppProvider } from './state/AppContext';
import { logger } from './utils/logger';
import './styles.css';
import './theme.css';

logger.info('Lifecycle', 'CircuitPilot Demo starting');

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <AppProvider>
        <App />
      </AppProvider>
    </ErrorBoundary>
  </React.StrictMode>,
);

logger.info('Lifecycle', 'CircuitPilot Demo mounted');
