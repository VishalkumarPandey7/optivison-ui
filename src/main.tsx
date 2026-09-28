import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { VisionProvider } from './vision';
import { LprProvider } from './lpr';
import './styles.css';

class ApplicationErrorBoundary extends React.Component<React.PropsWithChildren, { message: string }> {
  state = { message: '' };

  static getDerivedStateFromError(error: unknown) {
    return { message: error instanceof Error ? error.message : 'The interface encountered an unexpected error.' };
  }

  componentDidCatch(error: unknown) {
    console.error('OptiVision interface error', error);
  }

  render() {
    if (this.state.message) return <main className="application-error"><strong>OptiVision could not display this screen.</strong><p>{this.state.message}</p><button type="button" onClick={() => window.location.reload()}>Reload dashboard</button></main>;
    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ApplicationErrorBoundary>
      <VisionProvider>
        <LprProvider>
          <App />
        </LprProvider>
      </VisionProvider>
    </ApplicationErrorBoundary>
  </React.StrictMode>
);
