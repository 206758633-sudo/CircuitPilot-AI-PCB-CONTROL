import { Component, type ErrorInfo, type ReactNode } from 'react';
import { logger } from '../utils/logger';

interface Props { children: ReactNode }
interface State { error?: Error }

export class ErrorBoundary extends Component<Props, State> {
  state: State = {};

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    logger.error('ErrorBoundary', 'React render error', { message: error.message, componentStack: info.componentStack });
  }

  render() {
    if (this.state.error) {
      return (
        <main className="fatal-error">
          <div className="eyebrow">DEMO SAFE MODE</div>
          <h1>界面遇到异常</h1>
          <p>{this.state.error.message}</p>
          <button onClick={() => window.location.reload()}>重新加载Demo</button>
        </main>
      );
    }
    return this.props.children;
  }
}
