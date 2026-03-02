import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

interface ButtonConfig {
  id: string;
  label: string;
  command?: string;
  task?: string;
  vsCommand?: string;
  tooltip?: string;
  color?: string;
  runningColor?: string;
  alignment?: 'left' | 'right';
  priority?: number;
  cwd?: string;
  showOutput?: boolean;
}

interface ConfigFile {
  buttons: ButtonConfig[];
}

interface ManagedButton {
  config: ButtonConfig;
  statusBarItem: vscode.StatusBarItem;
  commandDisposable: vscode.Disposable;
  isRunning: boolean;
  process?: cp.ChildProcess;
}

class CommandButtonsManager {
  private buttons: Map<string, ManagedButton> = new Map();
  private outputChannel: vscode.OutputChannel;
  private context: vscode.ExtensionContext;
  private configFileWatcher?: vscode.FileSystemWatcher;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
    this.outputChannel = vscode.window.createOutputChannel('Command Buttons');
  }

  public initialize(): void {
    this.loadButtons();
    this.watchConfigFile();
  }

  private getConfigFilePath(): string | undefined {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceFolder) {
      return undefined;
    }
    return path.join(workspaceFolder, '.vscode', 'command-buttons.json');
  }

  private watchConfigFile(): void {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      return;
    }

    const pattern = new vscode.RelativePattern(workspaceFolder, '.vscode/command-buttons.json');
    this.configFileWatcher = vscode.workspace.createFileSystemWatcher(pattern);

    this.configFileWatcher.onDidChange(() => this.loadButtons());
    this.configFileWatcher.onDidCreate(() => this.loadButtons());
    this.configFileWatcher.onDidDelete(() => this.loadButtons());

    this.context.subscriptions.push(this.configFileWatcher);
  }

  private loadButtonConfigs(): ButtonConfig[] {
    const configFilePath = this.getConfigFilePath();
    if (configFilePath && fs.existsSync(configFilePath)) {
      try {
        const raw = fs.readFileSync(configFilePath, 'utf-8');
        const parsed: ConfigFile = JSON.parse(raw);
        if (Array.isArray(parsed.buttons)) {
          return parsed.buttons;
        }
      } catch (err) {
        vscode.window.showWarningMessage(
          `Failed to parse .vscode/command-buttons.json: ${err}`
        );
      }
    }

    return [];
  }

  private loadButtons(): void {
    // Dispose existing buttons and their commands
    this.buttons.forEach((button) => {
      button.commandDisposable.dispose();
      button.statusBarItem.dispose();
    });
    this.buttons.clear();

    const buttonConfigs = this.loadButtonConfigs();

    // Validate configs
    buttonConfigs.forEach((buttonConfig) => {
      const modes = [buttonConfig.command, buttonConfig.task, buttonConfig.vsCommand].filter(Boolean);
      if (modes.length === 0) {
        vscode.window.showWarningMessage(
          `Button "${buttonConfig.id}" has no "command", "task", or "vsCommand" — skipping.`
        );
        return;
      }
      if (modes.length > 1) {
        vscode.window.showWarningMessage(
          `Button "${buttonConfig.id}" has multiple execution modes — using first found.`
        );
      }
      this.createButton(buttonConfig);
    });
  }

  private createButton(config: ButtonConfig): void {
    const alignment = config.alignment === 'right'
      ? vscode.StatusBarAlignment.Right
      : vscode.StatusBarAlignment.Left;

    const statusBarItem = vscode.window.createStatusBarItem(
      alignment,
      config.priority || 0
    );

    statusBarItem.text = config.label;
    statusBarItem.tooltip = config.tooltip || (
      config.task
        ? `Run task: ${config.task}`
        : config.vsCommand
          ? `Run VS Code command: ${config.vsCommand}`
          : `Run: ${config.command}`
    );
    statusBarItem.command = `commandButtons.run.${config.id}`;

    if (config.color) {
      statusBarItem.color = config.color;
    }

    statusBarItem.show();

    // Register the command for this button
    const commandDisposable = vscode.commands.registerCommand(
      `commandButtons.run.${config.id}`,
      () => this.runCommand(config.id)
    );

    const managedButton: ManagedButton = {
      config,
      statusBarItem,
      commandDisposable,
      isRunning: false,
    };

    this.buttons.set(config.id, managedButton);
  }

  private async runCommand(buttonId: string): Promise<void> {
    const button = this.buttons.get(buttonId);
    if (!button) {
      vscode.window.showErrorMessage(`Button "${buttonId}" not found`);
      return;
    }

    if (button.isRunning) {
      // If already running, offer to kill the process (shell commands only)
      if (button.config.task) {
        vscode.window.showWarningMessage(
          `Task "${button.config.label}" is already running. Use the terminal to manage it.`
        );
        return;
      }
      const action = await vscode.window.showWarningMessage(
        `Command "${button.config.label}" is already running. Kill it?`,
        'Kill',
        'Cancel'
      );
      if (action === 'Kill' && button.process) {
        button.process.kill();
      }
      return;
    }

    // Dispatch to the appropriate runner
    if (button.config.task) {
      await this.runTask(button);
    } else if (button.config.vsCommand) {
      await this.runVsCommand(button);
    } else {
      await this.runShellCommand(button);
    }
  }

  private async runVsCommand(button: ManagedButton): Promise<void> {
    try {
      await vscode.commands.executeCommand(button.config.vsCommand!);
    } catch (err) {
      vscode.window.showErrorMessage(
        `Failed to execute VS Code command "${button.config.vsCommand}": ${err}`
      );
    }
  }

  private async runTask(button: ManagedButton): Promise<void> {
    const taskName = button.config.task!;

    // Find the task by label
    const tasks = await vscode.tasks.fetchTasks();
    const matchedTask = tasks.find((t) => t.name === taskName);

    if (!matchedTask) {
      vscode.window.showErrorMessage(
        `Task "${taskName}" not found in tasks.json`
      );
      return;
    }

    this.setRunningState(button, true);

    const execution = await vscode.tasks.executeTask(matchedTask);

    // Listen for task completion
    const disposable = vscode.tasks.onDidEndTaskProcess((e) => {
      if (e.execution === execution) {
        this.setRunningState(button, false);
        disposable.dispose();

        if (e.exitCode === 0) {
          vscode.window.setStatusBarMessage(
            `✓ ${button.config.label} completed`,
            3000
          );
        } else {
          vscode.window.showWarningMessage(
            `${button.config.label} exited with code ${e.exitCode}`
          );
        }
      }
    });
  }

  private async runShellCommand(button: ManagedButton): Promise<void> {
    this.setRunningState(button, true);

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const cwd = button.config.cwd
      ? path.resolve(workspaceFolder || '', button.config.cwd)
      : workspaceFolder;

    this.outputChannel.appendLine(
      `\n[${new Date().toLocaleTimeString()}] Running: ${button.config.command}`
    );
    this.outputChannel.appendLine(`Working directory: ${cwd}`);
    this.outputChannel.appendLine('---');

    if (button.config.showOutput !== false) {
      this.outputChannel.show(true);
    }

    const userShell = process.env.SHELL || '/bin/sh';
    button.process = cp.spawn(userShell, ['-ic', button.config.command!], {
      cwd,
      env: { ...process.env },
    });

    button.process.stdout?.on('data', (data: Buffer) => {
      this.outputChannel.append(data.toString());
    });

    button.process.stderr?.on('data', (data: Buffer) => {
      const filtered = data.toString()
        .split('\n')
        .filter((line) => !line.includes('terminfo[') && !line.includes('__key-bindings'))
        .join('\n');
      if (filtered.trim()) {
        this.outputChannel.append(filtered);
      }
    });

    button.process.on('close', (code: number | null) => {
      this.outputChannel.appendLine(`\n[Exit code: ${code}]`);
      this.setRunningState(button, false);
      button.process = undefined;

      if (code === 0) {
        vscode.window.setStatusBarMessage(
          `✓ ${button.config.label} completed`,
          3000
        );
      } else {
        vscode.window.showWarningMessage(
          `${button.config.label} exited with code ${code}`
        );
      }
    });

    button.process.on('error', (err: Error) => {
      this.outputChannel.appendLine(`\n[Error: ${err.message}]`);
      this.setRunningState(button, false);
      button.process = undefined;
      vscode.window.showErrorMessage(`Failed to run: ${err.message}`);
    });
  }

  private setRunningState(button: ManagedButton, isRunning: boolean): void {
    button.isRunning = isRunning;

    if (isRunning) {
      const originalLabel = button.config.label;
      button.statusBarItem.text = `$(sync~spin) ${originalLabel.replace(/^\$\([^)]+\)\s*/, '')}`;
      if (button.config.runningColor) {
        button.statusBarItem.color = button.config.runningColor;
      } else {
        button.statusBarItem.backgroundColor = new vscode.ThemeColor(
          'statusBarItem.warningBackground'
        );
      }
    } else {
      button.statusBarItem.text = button.config.label;
      button.statusBarItem.color = button.config.color;
      button.statusBarItem.backgroundColor = undefined;
    }
  }

  public dispose(): void {
    this.buttons.forEach((button) => {
      if (button.process) {
        button.process.kill();
      }
      button.commandDisposable.dispose();
      button.statusBarItem.dispose();
    });
    this.outputChannel.dispose();
    this.configFileWatcher?.dispose();
  }
}

let manager: CommandButtonsManager;

export function activate(context: vscode.ExtensionContext): void {
  manager = new CommandButtonsManager(context);
  manager.initialize();

  const reloadCommand = vscode.commands.registerCommand(
    'commandButtons.reload',
    () => {
      manager.dispose();
      manager = new CommandButtonsManager(context);
      manager.initialize();
      vscode.window.showInformationMessage('Command Buttons reloaded');
    }
  );
  context.subscriptions.push(reloadCommand);
}

export function deactivate(): void {
  if (manager) {
    manager.dispose();
  }
}
