/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
'use strict'

import path from 'path'
import fs from 'fs'
import {
  workspace as Workspace, events, Document, window as Window, commands as Commands, languages as Languages, Disposable, ExtensionContext, Uri, TextDocument, CodeActionContext, Diagnostic, ProviderResult, Command, QuickPickItem,
  WorkspaceFolder as VWorkspaceFolder, MessageItem, DiagnosticSeverity as VDiagnosticSeverity,
  DiagnosticCollection, Range, Position,
  LanguageClient, LanguageClientOptions, RequestType, TransportKind, TextDocumentIdentifier, NotificationType, ErrorHandler,
  ErrorAction, CloseAction, State as ClientState, RevealOutputChannelOn,
  ServerOptions, DocumentFilter,
  WorkspaceFolder, NotificationType0,
} from 'coc.nvim'
import {
  CodeActionKind,
  VersionedTextDocumentIdentifier,
  ExecuteCommandParams, DidCloseTextDocumentNotification, DidOpenTextDocumentNotification, DidChangeConfigurationNotification,
  ExecuteCommandRequest,
  CodeActionRequest,
  CodeActionParams,
  CodeAction
} from 'vscode-languageserver-protocol'

import { findEslint, convert2RegExp, toOSPath, toPosixPath, Semaphore } from './utils'
import EslintTask from './task'

enum ConfigurationTarget {
  Global,
  User,
  Workspace
}

namespace Is {
  const toString = Object.prototype.toString

  export function boolean(value: any): value is boolean {
    return value === true || value === false
  }

  export function string(value: any): value is string {
    return toString.call(value) === '[object String]'
  }

  export function objectLiteral(value: any): value is object {
    return value !== null && value !== undefined && !Array.isArray(value) && typeof value === 'object'
  }
}

interface ValidateItem {
  language: string
  autoFix?: boolean
}

namespace ValidateItem {
  export function is(item: any): item is ValidateItem {
    const candidate = item as ValidateItem
    return candidate && Is.string(candidate.language) && (Is.boolean(candidate.autoFix) || candidate.autoFix === void 0)
  }
}

interface LegacyDirectoryItem {
  directory: string
  changeProcessCWD: boolean
}

namespace LegacyDirectoryItem {
  export function is(item: any): item is LegacyDirectoryItem {
    const candidate = item as LegacyDirectoryItem
    return candidate && Is.string(candidate.directory) && Is.boolean(candidate.changeProcessCWD)
  }
}

enum ModeEnum {
  auto = 'auto',
  location = 'location'
}

namespace ModeEnum {
  export function is(value: string): value is ModeEnum {
    return value === ModeEnum.auto || value === ModeEnum.location
  }
}

interface ModeItem {
  mode: ModeEnum
}

namespace ModeItem {
  export function is(item: any): item is ModeItem {
    const candidate = item as ModeItem
    return candidate && ModeEnum.is(candidate.mode)
  }
}

interface DirectoryItem {
  directory: string
  '!cwd'?: boolean
}

namespace DirectoryItem {
  export function is(item: any): item is DirectoryItem {
    const candidate = item as DirectoryItem
    return candidate && Is.string(candidate.directory) && (Is.boolean(candidate['!cwd']) || candidate['!cwd'] === undefined)
  }
}

interface PatternItem {
  pattern: string
  '!cwd'?: boolean
}

namespace PatternItem {
  export function is(item: any): item is PatternItem {
    const candidate = item as PatternItem
    return candidate && Is.string(candidate.pattern) && (Is.boolean(candidate['!cwd']) || candidate['!cwd'] === undefined)
  }
}

type RunValues = 'onType' | 'onSave'

interface CodeActionSettings {
  disableRuleComment: {
    enable: boolean
    location: 'separateLine' | 'sameLine'
  }
  showDocumentation: {
    enable: boolean
  }
}

enum CodeActionsOnSaveMode {
  all = 'all',
  problems = 'problems'
}

namespace CodeActionsOnSaveMode {
  export function from(value: string | undefined | null): CodeActionsOnSaveMode {
    if (value === undefined || value === null) {
      return CodeActionsOnSaveMode.all
    }
    switch (value.toLowerCase()) {
      case CodeActionsOnSaveMode.problems:
        return CodeActionsOnSaveMode.problems
      default:
        return CodeActionsOnSaveMode.all
    }
  }
}

interface CodeActionsOnSaveSettings {
  enable: boolean
  mode: CodeActionsOnSaveMode
}

enum Validate {
  on = 'on',
  off = 'off',
  probe = 'probe'
}

enum ESLintSeverity {
  off = 'off',
  warn = 'warn',
  error = 'error'
}

namespace ESLintSeverity {
  export function from(value: string | undefined | null): ESLintSeverity {
    if (value === undefined || value === null) {
      return ESLintSeverity.off
    }
    switch (value.toLowerCase()) {
      case ESLintSeverity.off:
        return ESLintSeverity.off
      case ESLintSeverity.warn:
        return ESLintSeverity.warn
      case ESLintSeverity.error:
        return ESLintSeverity.error
      default:
        return ESLintSeverity.off
    }
  }
}

enum ConfirmationSelection {
  deny = 1,
  disable = 2,
  allow = 3,
  alwaysAllow = 4
}

interface ConfigurationSettings {
  validate: Validate
  packageManager: 'npm' | 'yarn' | 'pnpm'
  codeAction: CodeActionSettings
  codeActionOnSave: CodeActionsOnSaveSettings
  format: boolean
  quiet: boolean
  onIgnoredFiles: ESLintSeverity
  options: any | undefined
  run: RunValues
  nodePath: string | null
  workspaceFolder: WorkspaceFolder | undefined
  workingDirectory: ModeItem | DirectoryItem | undefined
}

interface NoESLintState {
  global?: boolean
  workspaces?: { [key: string]: boolean }
}

enum Status {
  ok = 1,
  warn = 2,
  error = 3,
  confirmationPending = 4,
  executionDisabled = 5,
  executionDenied = 6
}

interface StatusParams {
  uri: string
  state: Status
}

namespace StatusNotification {
  export const type = new NotificationType<StatusParams>('eslint/status')
}

interface NoConfigParams {
  message: string
  document: TextDocumentIdentifier
}

interface NoConfigResult {
}

namespace NoConfigRequest {
  export const type = new RequestType<NoConfigParams, NoConfigResult, void>('eslint/noConfig')
}


interface NoESLintLibraryParams {
  source: TextDocumentIdentifier
}

interface NoESLintLibraryResult {
}

namespace NoESLintLibraryRequest {
  export const type = new RequestType<NoESLintLibraryParams, NoESLintLibraryResult, void>('eslint/noLibrary')
}

interface OpenESLintDocParams {
  url: string
}

interface OpenESLintDocResult {

}

namespace OpenESLintDocRequest {
  export const type = new RequestType<OpenESLintDocParams, OpenESLintDocResult, void>('eslint/openDoc')
}

interface ProbeFailedParams {
  textDocument: TextDocumentIdentifier
}

namespace ProbeFailedRequest {
  export const type = new RequestType<ProbeFailedParams, void, void>('eslint/probeFailed')
}

interface ESLintExecutionState {
  libs: { [key: string]: boolean }
}

interface ExecutionParams {
  scope: 'local' | 'global'
  libraryPath: string
}

interface ConfirmExecutionParams extends ExecutionParams {
  uri: string
}

enum ConfirmExecutionResult {
  denied = 1,
  confirmationPending = 2,
  disabled = 3,
  approved = 4
}

namespace ConfirmExecutionResult {
  export function toStatus(value: ConfirmExecutionResult): Status {
    switch (value) {
      case ConfirmExecutionResult.denied:
        return Status.executionDenied
      case ConfirmExecutionResult.confirmationPending:
        return Status.confirmationPending
      case ConfirmExecutionResult.disabled:
        return Status.executionDisabled
      case ConfirmExecutionResult.approved:
        return Status.ok
    }
  }
}

namespace ConfirmExecution {
  export const type = new RequestType<ConfirmExecutionParams, ConfirmExecutionResult, void>('eslint/confirmESLintExecution')
}

namespace ShowOutputChannel {
  export const type = new NotificationType0('eslint/showOutputChannel')
}

const exitCalled = new NotificationType<[number, string]>('eslint/exitCalled')

interface WorkspaceFolderItem extends QuickPickItem {
  folder: VWorkspaceFolder
}

async function pickFolder(folders: ReadonlyArray<VWorkspaceFolder>, placeHolder: string): Promise<VWorkspaceFolder | undefined> {
  if (folders.length === 1) {
    return Promise.resolve(folders[0])
  }

  const selected = await Window.showQuickpick(
    folders.map<string>((folder) => { return folder.name }),
    placeHolder
  )
  if (selected === -1) {
    return undefined
  }
  return folders[selected]
}

function createDefaultConfiguration(): void {
  const folders = Workspace.workspaceFolders
  if (!folders) {
    Window.showErrorMessage('An ESLint configuration can only be generated if VS Code is opened on a workspace folder.')
    return
  }
  const noConfigFolders = folders.filter(folder => {
    const configFiles = ['.eslintrc.js', '.eslintrc.yaml', '.eslintrc.yml', '.eslintrc', '.eslintrc.json']
    for (const configFile of configFiles) {
      if (fs.existsSync(path.join(Uri.parse(folder.uri).fsPath, configFile))) {
        return false
      }
    }
    return true
  })
  if (noConfigFolders.length === 0) {
    if (folders.length === 1) {
      Window.showInformationMessage('The workspace already contains an ESLint configuration file.')
    } else {
      Window.showInformationMessage('All workspace folders already contain an ESLint configuration file.')
    }
    return
  }
  pickFolder(noConfigFolders, 'Select a workspace folder to generate a ESLint configuration for').then(async (folder) => {
    if (!folder) {
      return
    }
    const folderRootPath = Uri.parse(folder.uri).fsPath
    const terminal = await Workspace.createTerminal({
      name: `ESLint init`,
      cwd: folderRootPath
    })
    const eslintCommand = await findEslint(folderRootPath)
    terminal.sendText(`${eslintCommand} --init`)
    terminal.show()
  })
}

let onActivateCommands: Disposable[] | undefined

const probeFailed: Set<string> = new Set()
function computeValidate(textDocument: TextDocument): Validate {
  const config = Workspace.getConfiguration('eslint', textDocument.uri)
  if (!config.get('enable', true)) {
    return Validate.off
  }
  const languageId = textDocument.languageId
  const validate = config.get<(ValidateItem | string)[]>('validate')
  if (Array.isArray(validate)) {
    for (const item of validate) {
      if (Is.string(item) && item === languageId) {
        return Validate.on
      } else if (ValidateItem.is(item) && item.language === languageId) {
        return Validate.on
      }
    }
  }
  const uri: string = textDocument.uri.toString()
  if (probeFailed.has(uri)) {
    return Validate.off
  }
  const probe: string[] | undefined = config.get<string[]>('probe')
  if (Array.isArray(probe)) {
    for (const item of probe) {
      if (item === languageId) {
        return Validate.probe
      }
    }
  }
  return Validate.off
}

const eslintExecutionKey = 'eslintLibraries'
let eslintExecutionState: ESLintExecutionState

const eslintAlwaysAllowExecutionKey = 'eslintAlwaysAllowExecution'
let eslintAlwaysAllowExecutionState: boolean = false

const sessionState: Map<string, ExecutionParams> = new Map()
const disabledLibraries: Set<string> = new Set()

type ResourceInfo = {
  status: Status
  executionInfo: ExecutionInfo | undefined
}
const resource2ResourceInfo: Map<string, ResourceInfo> = new Map()
let globalStatus: Status | undefined

type ExecutionInfo = {
  params: ExecutionParams
  result: ConfirmExecutionResult
  editorErrorUri: Uri | undefined
  diagnostics: DiagnosticCollection
  codeActionProvider: Disposable | undefined
}
let lastExecutionInfo: ExecutionInfo | undefined
const libraryPath2ExecutionInfo: Map<string, ExecutionInfo> = new Map()
const workspaceFolder2ExecutionInfos: Map<string, ExecutionInfo[]> = new Map()

function updateExecutionInfo(params: ExecutionParams, result: ConfirmExecutionResult): void {
  let value: ExecutionInfo | undefined = libraryPath2ExecutionInfo.get(params.libraryPath)
  if (value === undefined) {
    value = {
      params: { libraryPath: params.libraryPath, scope: params.scope },
      result: result,
      editorErrorUri: undefined,
      codeActionProvider: undefined,
      diagnostics: Languages.createDiagnosticCollection()
    }
    libraryPath2ExecutionInfo.set(params.libraryPath, value)
  } else {
    value.result = result
  }
}

function updateStatusInfo(param: StatusParams): void {
  globalStatus = param.state
  let info = resource2ResourceInfo.get(param.uri)
  if (info === undefined) {
    info = {
      executionInfo: undefined,
      status: param.state
    }
    resource2ResourceInfo.set(param.uri, info)
  } else {
    info.status = param.state
  }
}

function getExecutionInfo(doc: Document | undefined, strict: boolean): ExecutionInfo | undefined {
  if (doc == undefined) {
    return undefined
  }
  const info = resource2ResourceInfo.get(doc.uri)
  if (info !== undefined) {
    return info.executionInfo
  }
  if (!strict) {
    const folder = Workspace.getWorkspaceFolder(doc.uri)
    if (folder !== undefined) {
      const values = workspaceFolder2ExecutionInfos.get(folder.uri.toString())
      return values && values[0]
    }
  }
  return undefined
}

function clearInfo(info: ExecutionInfo): void {
  info.diagnostics.clear()
  if (info.codeActionProvider !== undefined) {
    info.codeActionProvider.dispose()
  }
}

function clearDiagnosticState(params: ExecutionParams): void {
  const info = libraryPath2ExecutionInfo.get(params.libraryPath)
  if (info === undefined) {
    return
  }
  clearInfo(info)
}

function clearAllDiagnosticState(): void {
  // Make a copy
  for (const info of Array.from(libraryPath2ExecutionInfo.values())) {
    clearInfo(info)
  }
}

async function askForLibraryConfirmation(client: LanguageClient | undefined, context: ExtensionContext, params: ExecutionParams, update: undefined | (() => void)): Promise<void> {
  sessionState.set(params.libraryPath, params)

  // Reevaluate state and cancel since the information message is async
  const libraryUri = Uri.file(params.libraryPath)
  const folder = Workspace.getWorkspaceFolder(libraryUri.toString())

  interface ConfirmMessageItem extends MessageItem {
    value: ConfirmationSelection
  }

  let message: string
  if (folder !== undefined) {
    let relativePath = libraryUri.toString().substr(folder.uri.toString().length + 1)
    const mainPath = '/lib/api.js'
    if (relativePath.endsWith(mainPath)) {
      relativePath = relativePath.substr(0, relativePath.length - mainPath.length)
    }
    message = `The ESLint extension will use '${relativePath}' for validation, which is installed locally in folder '${folder.name}'. Do you allow the execution of this ESLint version including all plugins and configuration files it will load on your behalf?\n\nPress 'Allow Everywhere' to remember the choice for all workspaces. Use 'Disable' to disable ESLint for this session.`
  } else {
    message = params.scope === 'global'
      ? `The ESLint extension will use a globally installed ESLint library for validation. Do you allow the execution of this ESLint version including all plugins and configuration files it will load on your behalf?\n\nPress 'Always Allow' to remember the choice for all workspaces. Use 'Cancel' to disable ESLint for this session.`
      : `The ESLint extension will use a locally installed ESLint library for validation. Do you allow the execution of this ESLint version including all plugins and configuration files it will load on your behalf?\n\nPress 'Always Allow' to remember the choice for all workspaces. Use 'Cancel' to disable ESLint for this session.`
  }

  const messageItems: ConfirmMessageItem[] = [
    { title: 'Allow Everywhere', value: ConfirmationSelection.alwaysAllow },
    { title: 'Allow', value: ConfirmationSelection.allow },
    { title: 'Deny', value: ConfirmationSelection.deny },
    { title: 'Disable', value: ConfirmationSelection.disable }
  ]
  const item = await Window.showInformationMessage<ConfirmMessageItem>(message, ...messageItems)

  // Dialog got canceled.
  if (item === undefined) {
    return
  }

  if (item.value === ConfirmationSelection.disable) {
    disabledLibraries.add(params.libraryPath)
    updateExecutionInfo(params, ConfirmExecutionResult.disabled)
    clearDiagnosticState(params)
  } else {
    disabledLibraries.delete(params.libraryPath)
    if (item.value === ConfirmationSelection.allow || item.value === ConfirmationSelection.deny) {
      const value = item.value === ConfirmationSelection.allow ? true : false
      eslintExecutionState.libs[params.libraryPath] = value
      context.globalState.update(eslintExecutionKey, eslintExecutionState)
      updateExecutionInfo(params, value ? ConfirmExecutionResult.approved : ConfirmExecutionResult.denied)
      clearDiagnosticState(params)
    } else if (item.value === ConfirmationSelection.alwaysAllow) {
      eslintAlwaysAllowExecutionState = true
      context.globalState.update(eslintAlwaysAllowExecutionKey, eslintAlwaysAllowExecutionState)
      updateExecutionInfo(params, ConfirmExecutionResult.approved)
      clearAllDiagnosticState()
    }
  }

  update && update()
  client && client.sendNotification(DidChangeConfigurationNotification.type.method, { settings: {} })
}

async function resetLibraryConfirmations(client: LanguageClient | undefined, context: ExtensionContext, update: undefined | (() => void)): Promise<void> {
  interface ESLintQuickPickItem extends QuickPickItem {
    kind: 'all' | 'allConfirmed' | 'allRejected' | 'session' | 'alwaysAllow'
  }
  const items: ESLintQuickPickItem[] = [
    { label: 'Reset ESLint library decisions for this workspace', kind: 'session' },
    { label: 'Reset all ESLint library decisions', kind: 'all' }
  ]
  if (eslintAlwaysAllowExecutionState) {
    items.splice(1, 0, { label: 'Reset Always Allow all ESlint libraries decision', kind: 'alwaysAllow' })
  }
  const selectedIdx = await Window.showQuickpick(items.map(o => o.label), 'Clear library confirmations')
  if (selectedIdx == -1) {
    return
  }
  let selected = items[selectedIdx]
  switch (selected.kind) {
    case 'all':
      eslintExecutionState.libs = {}
      eslintAlwaysAllowExecutionState = false
      break
    case 'alwaysAllow':
      eslintAlwaysAllowExecutionState = false
      break
    case 'session':
      if (sessionState.size === 1) {
        const param = sessionState.values().next().value
        await askForLibraryConfirmation(client, context, param, update)
        return
      } else {
        for (const lib of sessionState.keys()) {
          delete eslintExecutionState.libs[lib]
        }
      }
      break
  }
  context.globalState.update(eslintExecutionKey, eslintExecutionState)
  context.globalState.update(eslintAlwaysAllowExecutionKey, eslintAlwaysAllowExecutionState)
  disabledLibraries.clear()
  libraryPath2ExecutionInfo.clear()
  resource2ResourceInfo.clear()
  workspaceFolder2ExecutionInfos.clear()
  update && update()
  client && client.sendNotification(DidChangeConfigurationNotification.type.method, { settings: {} })
}

export function activate(context: ExtensionContext) {
  eslintExecutionState = context.globalState.get<ESLintExecutionState>(eslintExecutionKey, { libs: {} })
  eslintAlwaysAllowExecutionState = context.globalState.get<boolean>(eslintAlwaysAllowExecutionKey, false)

  function didOpenTextDocument(textDocument: TextDocument) {
    if (activated) {
      return
    }
    if (computeValidate(textDocument) !== Validate.off) {
      openListener.dispose()
      configurationListener.dispose()
      activated = true
      realActivate(context)
    }
  }

  function configurationChanged() {
    if (activated) {
      return
    }
    for (const textDocument of Workspace.textDocuments) {
      if (computeValidate(textDocument) !== Validate.off) {
        openListener.dispose()
        configurationListener.dispose()
        activated = true
        realActivate(context)
        return
      }
    }
  }

  let activated: boolean = false
  const openListener: Disposable = Workspace.onDidOpenTextDocument(didOpenTextDocument)
  const configurationListener: Disposable = Workspace.onDidChangeConfiguration(configurationChanged)

  const notValidating = async () => {
    let bufnr = await Workspace.nvim.call('bufnr', ['%'])
    let doc = Workspace.getDocument(bufnr)
    const enabled = Workspace.getConfiguration('eslint', doc ? doc.uri : undefined).get('enable', true)
    if (!enabled) {
      Window.showInformationMessage(`ESLint is not running because the deprecated setting 'eslint.enable' is set to false. Remove the setting and use the extension disablement feature.`)
    } else {
      Window.showInformationMessage('ESLint is not running. By default only TypeScript and JavaScript files are validated. If you want to validate other file types please specify them in the \'eslint.probe\' setting.')
    }
  }
  onActivateCommands = [
    Commands.registerCommand('eslint.executeAutofix', notValidating),
    Commands.registerCommand('eslint.showOutputChannel', notValidating),
    Commands.registerCommand('eslint.manageLibraryExecution', notValidating),
    Commands.registerCommand('eslint.resetLibraryExecution', () => {
      resetLibraryConfirmations(undefined, context, undefined)
    })
  ]

  context.subscriptions.push(
    Commands.registerCommand('eslint.createConfig', createDefaultConfiguration)
  )
  context.subscriptions.push(new EslintTask())
  configurationChanged()
}

interface InspectData<T> {
  globalValue?: T
  workspaceValue?: T
  workspaceFolderValue?: T
}
interface MigrationElement<T> {
  changed: boolean
  value: T | undefined
}

interface MigrationData<T> {
  global: MigrationElement<T>
  workspace: MigrationElement<T>
  workspaceFolder: MigrationElement<T>
}

interface CodeActionsOnSaveMap {
  'source.fixAll'?: boolean
  'source.fixAll.eslint'?: boolean
  [key: string]: boolean | undefined
}

type CodeActionsOnSave = CodeActionsOnSaveMap | string[] | null

namespace CodeActionsOnSave {
  export function isExplicitlyDisabled(setting: CodeActionsOnSave | undefined): boolean {
    if (setting === undefined || setting === null || Array.isArray(setting)) {
      return false
    }
    return setting['source.fixAll.eslint'] === false
  }

  export function getSourceFixAll(setting: CodeActionsOnSave): boolean | undefined {
    if (setting === null) {
      return undefined
    } if (Array.isArray(setting)) {
      return setting.includes('source.fixAll') ? true : undefined
    } else {
      return setting['source.fixAll']
    }
  }

  export function getSourceFixAllESLint(setting: CodeActionsOnSave): boolean | undefined {
    if (setting === null) {
      return undefined
    } else if (Array.isArray(setting)) {
      return setting.includes('source.fixAll.eslint') ? true : undefined
    } else {
      return setting['source.fixAll.eslint']
    }
  }

  export function setSourceFixAllESLint(setting: CodeActionsOnSave, value: boolean | undefined): void {
    // If the setting is mistyped do nothing.
    if (setting === null) {
      return
    } else if (Array.isArray(setting)) {
      const index = setting.indexOf('source.fixAll.eslint')
      if (value === true) {
        if (index === -1) {
          setting.push('source.fixAll.eslint')
        }
      } else {
        if (index >= 0) {
          setting.splice(index, 1)
        }
      }
    } else {
      setting['source.fixAll.eslint'] = value
    }
  }
}

interface LanguageSettings {
  'editor.codeActionsOnSave'?: CodeActionsOnSave
}

function realActivate(context: ExtensionContext): void {

  const statusBarItem = Window.createStatusBarItem(0)
  context.subscriptions.push(statusBarItem)
  let serverRunning: boolean | undefined

  const starting = 'ESLint server is starting.'
  const running = 'ESLint server is running.'
  const stopped = 'ESLint server stopped.'
  statusBarItem.text = 'ESLint'

  function updateStatusBar(status: Status, isValidated: boolean) {
    let text: string = 'ESLint'
    switch (status) {
      case Status.ok:
        text = ''
        break
      case Status.warn:
        text = 'Eslint warning'
        break
      case Status.error:
        text = 'Eslint error'
        break
      case Status.executionDenied:
        text = 'Eslint denied'
        break
      case Status.executionDisabled:
        text = 'Eslint disabled'
        break
      case Status.confirmationPending:
        text = 'ESLint not approved or denied yet.'
        break
      default:
        text = ''
    }
    statusBarItem.text = serverRunning === undefined ? starting : text
    const alwaysShow = Workspace.getConfiguration('eslint').get('alwaysShowStatus', false)
    if (alwaysShow || eslintAlwaysAllowExecutionState === true || status !== Status.ok || (status === Status.ok && isValidated)) {
      statusBarItem.show()
    } else {
      statusBarItem.hide()
    }
  }

  const flaggedLanguages = new Set(['javascript', 'javascriptreact', 'typescript', 'typescriptreact'])
  async function updateStatusBarAndDiagnostics(): Promise<void> {
    let doc = await Workspace.document

    function clearLastExecutionInfo(): void {
      if (lastExecutionInfo === undefined) {
        return
      }
      if (lastExecutionInfo.codeActionProvider !== undefined) {
        lastExecutionInfo.codeActionProvider.dispose()
        lastExecutionInfo.codeActionProvider = undefined
      }
      if (lastExecutionInfo.editorErrorUri !== undefined) {
        lastExecutionInfo.diagnostics.delete(lastExecutionInfo.editorErrorUri.toString())
        lastExecutionInfo.editorErrorUri = undefined
      }
      lastExecutionInfo = undefined
    }

    function handleEditor(doc: Document): void {
      const uri = doc.uri

      const resourceInfo = resource2ResourceInfo.get(uri)
      if (resourceInfo === undefined) {
        return
      }
      const info = resourceInfo.executionInfo
      if (info === undefined) {
        return
      }

      if (info.result === ConfirmExecutionResult.confirmationPending && info.editorErrorUri?.toString() !== uri.toString()) {
        const range = doc.getWordRangeAtPosition(Position.create(0, 0)) ?? Range.create(0, 0, 0, 0)
        const diagnostic = Diagnostic.create(
          range,
          'ESLint is disabled since its execution has not been approved or denied yet. Use :CocCommand eslint.showOutputChannel to open the approval dialog.', VDiagnosticSeverity.Warning
        )
        diagnostic.source = 'eslint'
        const errorUri = doc.uri

        info.diagnostics.set(errorUri, [diagnostic])
        if (info.editorErrorUri !== undefined) {
          info.diagnostics.delete(info.editorErrorUri.toString())
        }
        info.editorErrorUri = Uri.parse(errorUri)
        if (info.codeActionProvider !== undefined) {
          info.codeActionProvider.dispose()
        }
        info.codeActionProvider = Languages.registerCodeActionProvider([{ pattern: Uri.parse(errorUri).fsPath }], {
          provideCodeActions: (_document, _range, context) => {
            for (const diag of context.diagnostics) {
              if (diag === diagnostic) {
                const result: CodeAction = {
                  title: 'ESLint: Manage Library Execution',
                  kind: CodeActionKind.QuickFix
                }
                result.isPreferred = true
                result.command = {
                  title: 'Manage Library Execution',
                  command: 'eslint.manageLibraryExecution',
                  arguments: [info.params]
                }
                return [result]
              }
            }
            return []
          }
        }, 'eslint-library')
      }

      lastExecutionInfo = info
    }

    function findApplicableStatus(editor: Document | undefined): [Status, boolean] {
      let candidates: IterableIterator<ExecutionInfo> | ExecutionInfo[] | undefined
      if (editor !== undefined) {
        const resourceInfo = resource2ResourceInfo.get(editor.uri)
        if (resourceInfo !== undefined) {
          return [resourceInfo.status, true]
        }
        const workspaceFolder = Workspace.getWorkspaceFolder(editor.uri)
        if (workspaceFolder !== undefined) {
          candidates = workspaceFolder2ExecutionInfos.get(workspaceFolder.uri.toString())
        }
      }
      if (candidates === undefined) {
        candidates = libraryPath2ExecutionInfo.values()
      }
      let result: ConfirmExecutionResult | undefined
      for (const info of candidates) {
        if (result === undefined) {
          result = info.result
        } else {
          if (info.result === ConfirmExecutionResult.confirmationPending) {
            result = info.result
            break
          } else if (info.result === ConfirmExecutionResult.denied || info.result === ConfirmExecutionResult.disabled) {
            result = info.result
          }
        }
      }
      return [result !== undefined ? ConfirmExecutionResult.toStatus(result) : Status.ok, false]
    }

    const executionInfo = getExecutionInfo(doc, true)
    if (lastExecutionInfo !== executionInfo) {
      clearLastExecutionInfo()
    }

    if (doc && doc.attached && flaggedLanguages.has(doc.filetype)) {
      handleEditor(doc)
    } else {
      clearLastExecutionInfo()
    }

    const [status, isValidated] = findApplicableStatus(doc)
    updateStatusBar(status, isValidated)
  }

  const serverModule = context.asAbsolutePath('lib/server.js')
  // Uri.joinPath(context.extensionUri, 'server', 'out', 'eslintServer.js').fsPath
  const eslintConfig = Workspace.getConfiguration('eslint')
  const runtime = eslintConfig.get('runtime', undefined)
  const debug = eslintConfig.get('debug')
  const argv = eslintConfig.get<string[]>('execArgv', [])
  const nodeEnv = eslintConfig.get('nodeEnv', null)

  let env: { [key: string]: string | number | boolean } | undefined
  if (debug) {
    env = env || {}
    env.DEBUG = 'eslint:*,-eslint:code-path'
  }
  if (nodeEnv) {
    env = env || {}
    env.NODE_ENV = nodeEnv
  }
  const serverOptions: ServerOptions = {
    run: { module: serverModule, transport: TransportKind.ipc, runtime, options: { cwd: Workspace.cwd, env, execArgv: argv } },
    debug: { module: serverModule, transport: TransportKind.ipc, runtime, options: { execArgv: argv.concat(['--nolazy', '--inspect=6011']), cwd: process.cwd(), env } }
  }

  let defaultErrorHandler: ErrorHandler
  let serverCalledProcessExit: boolean = false

  const packageJsonFilter: DocumentFilter = { scheme: 'file', pattern: '**/package.json' }
  const configFileFilter: DocumentFilter = { scheme: 'file', pattern: '**/.eslintr{c.js,c.yaml,c.yml,c,c.json}' }
  const syncedDocuments: Map<string, TextDocument> = new Map<string, TextDocument>()
  const confirmationSemaphore: Semaphore<ConfirmExecutionResult> = new Semaphore<ConfirmExecutionResult>(1)
  const supportedQuickFixKinds: Set<string> = new Set([CodeActionKind.Source, CodeActionKind.SourceFixAll, `${CodeActionKind.SourceFixAll}.eslint`, CodeActionKind.QuickFix])
  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ scheme: 'file' }, { scheme: 'untitled' }],
    diagnosticCollectionName: 'eslint',
    revealOutputChannelOn: RevealOutputChannelOn.Never,
    initializationOptions: {
    },
    progressOnInitialization: true,
    synchronize: {
      // configurationSection: 'eslint',
      fileEvents: [
        Workspace.createFileSystemWatcher('**/.eslintr{c.js,c.yaml,c.yml,c,c.json}'),
        Workspace.createFileSystemWatcher('**/.eslintignore'),
        Workspace.createFileSystemWatcher('**/package.json')
      ]
    },
    initializationFailedHandler: (error) => {
      client.error('Server initialization failed.', error)
      client.outputChannel.show(true)
      return false
    },
    errorHandler: {
      error: (error, message, count): ErrorAction => {
        return defaultErrorHandler.error(error, message, count)
      },
      closed: (): CloseAction => {
        if (serverCalledProcessExit) {
          return CloseAction.DoNotRestart
        }
        return defaultErrorHandler.closed()
      }
    },
    middleware: {
      didOpen: (document, next) => {
        if (Workspace.match([packageJsonFilter], document) || Workspace.match([configFileFilter], document) || computeValidate(document) !== Validate.off) {
          next(document)
          syncedDocuments.set(document.uri, document)
          return
        }
      },
      didChange: (event, next) => {
        if (syncedDocuments.has(event.textDocument.uri)) {
          next(event)
        }
      },
      willSave: (event, next) => {
        if (syncedDocuments.has(event.document.uri)) {
          next(event)
        }
      },
      willSaveWaitUntil: (event, next) => {
        if (syncedDocuments.has(event.document.uri)) {
          return next(event)
        } else {
          return Promise.resolve([])
        }
      },
      didSave: (document, next) => {
        if (syncedDocuments.has(document.uri)) {
          next(document)
        }
      },
      didClose: (document, next) => {
        const uri = document.uri
        if (syncedDocuments.has(uri)) {
          syncedDocuments.delete(uri)
          next(document)
        }
      },
      provideCodeActions: (document, range, context, token, next): ProviderResult<(Command | CodeAction)[]> => {
        if (!syncedDocuments.has(document.uri.toString())) {
          return []
        }
        if (context.only !== undefined && !supportedQuickFixKinds.has(context.only[0])) {
          return []
        }
        if (context.only === undefined && (!context.diagnostics || context.diagnostics.length === 0)) {
          return []
        }
        const eslintDiagnostics: Diagnostic[] = []
        for (const diagnostic of context.diagnostics) {
          if (diagnostic.source === 'eslint') {
            eslintDiagnostics.push(diagnostic)
          }
        }
        if (context.only === undefined && eslintDiagnostics.length === 0) {
          return []
        }
        const newContext: CodeActionContext = Object.assign({}, context, { diagnostics: eslintDiagnostics } as CodeActionContext)
        return next(document, range, newContext, token)
      },
      workspace: {
        didChangeWatchedFile: (event, next) => {
          probeFailed.clear()
          next(event)
        },
        didChangeConfiguration: (sections, next) => {
          next(sections)
        },
        configuration: async (params, _token, _next): Promise<any[]> => {
          if (params.items === undefined) {
            return []
          }
          const result: (ConfigurationSettings | null)[] = []
          for (const item of params.items) {
            if (item.section || !item.scopeUri) {
              result.push(null)
              continue
            }
            const resource = item.scopeUri
            const config = Workspace.getConfiguration('eslint', resource)
            const workspaceFolder = Workspace.getWorkspaceFolder(resource)
            const settings: ConfigurationSettings = {
              validate: Validate.off,
              packageManager: config.get('packageManager', 'npm'),
              codeActionOnSave: {
                enable: false,
                mode: CodeActionsOnSaveMode.all
              },
              format: false,
              quiet: config.get('quiet', false),
              onIgnoredFiles: ESLintSeverity.from(config.get<string>('onIgnoredFiles', ESLintSeverity.off)),
              options: config.get('options', {}),
              run: config.get('run', 'onType'),
              nodePath: config.get('nodePath', null),
              workingDirectory: undefined,
              workspaceFolder: undefined,
              codeAction: {
                disableRuleComment: config.get('codeAction.disableRuleComment', { enable: true, location: 'separateLine' as 'separateLine' }),
                showDocumentation: config.get('codeAction.showDocumentation', { enable: true })
              }
            }
            const document: TextDocument | undefined = syncedDocuments.get(item.scopeUri)
            if (document === undefined) {
              result.push(settings)
              continue
            }
            if (config.get('enabled', true)) {
              settings.validate = computeValidate(document)
            }
            if (settings.validate !== Validate.off) {
              settings.format = !!config.get('format.enable', false)
              settings.codeActionOnSave.enable = !!config.get('autoFixOnSave', false) //readCodeActionsOnSaveSetting(document)
              settings.codeActionOnSave.mode = CodeActionsOnSaveMode.from(config.get('codeActionsOnSave.mode', CodeActionsOnSaveMode.all))
            }
            if (workspaceFolder !== undefined) {
              settings.workspaceFolder = {
                name: workspaceFolder.name,
                uri: workspaceFolder.uri
              }
            }
            const workingDirectories = config.get<(string | LegacyDirectoryItem | DirectoryItem | PatternItem | ModeItem)[] | undefined>('workingDirectories', undefined)
            if (Array.isArray(workingDirectories)) {
              let workingDirectory: ModeItem | DirectoryItem | undefined = undefined
              const workspaceFolderPath = workspaceFolder && Uri.parse(workspaceFolder.uri).scheme === 'file' ? Uri.parse(workspaceFolder.uri).fsPath : undefined
              for (const entry of workingDirectories) {
                let directory: string | undefined
                let pattern: string | undefined
                let noCWD = false
                if (Is.string(entry)) {
                  directory = entry
                } else if (LegacyDirectoryItem.is(entry)) {
                  directory = entry.directory
                  noCWD = !entry.changeProcessCWD
                } else if (DirectoryItem.is(entry)) {
                  directory = entry.directory
                  if (entry['!cwd'] !== undefined) {
                    noCWD = entry['!cwd']
                  }
                } else if (PatternItem.is(entry)) {
                  pattern = entry.pattern
                  if (entry['!cwd'] !== undefined) {
                    noCWD = entry['!cwd']
                  }
                } else if (ModeItem.is(entry)) {
                  workingDirectory = entry
                  continue
                }

                let itemValue: string | undefined
                if (directory !== undefined || pattern !== undefined) {
                  const uri = Uri.parse(document.uri)
                  const filePath = uri.scheme === 'file' ? uri.fsPath : undefined
                  if (filePath !== undefined) {
                    if (directory !== undefined) {
                      directory = toOSPath(directory)
                      if (!path.isAbsolute(directory) && workspaceFolderPath !== undefined) {
                        directory = path.join(workspaceFolderPath, directory)
                      }
                      if (directory.charAt(directory.length - 1) !== path.sep) {
                        directory = directory + path.sep
                      }
                      if (filePath.startsWith(directory)) {
                        itemValue = directory
                      }
                    } else if (pattern !== undefined && pattern.length > 0) {
                      if (!path.posix.isAbsolute(pattern) && workspaceFolderPath !== undefined) {
                        pattern = path.posix.join(toPosixPath(workspaceFolderPath), pattern)
                      }
                      if (pattern.charAt(pattern.length - 1) !== path.posix.sep) {
                        pattern = pattern + path.posix.sep
                      }
                      const regExp: RegExp | undefined = convert2RegExp(pattern)
                      if (regExp !== undefined) {
                        const match = regExp.exec(filePath)
                        if (match !== null && match.length > 0) {
                          itemValue = match[0]
                        }
                      }
                    }
                  }
                }
                if (itemValue !== undefined) {
                  if (workingDirectory === undefined || ModeItem.is(workingDirectory)) {
                    workingDirectory = { directory: itemValue, '!cwd': noCWD }
                  } else {
                    if (workingDirectory.directory.length < itemValue.length) {
                      workingDirectory.directory = itemValue
                      workingDirectory['!cwd'] = noCWD
                    }
                  }
                }
              }
              settings.workingDirectory = workingDirectory
            }
            result.push(settings)
          }
          return result
        }
      }
    }
  }

  let client: LanguageClient
  try {
    client = new LanguageClient('ESLint', serverOptions, clientOptions)
  } catch (err) {
    Window.showErrorMessage(`The ESLint extension couldn't be started. See the ESLint output channel for details.`)
    return
  }

  Workspace.registerAutocmd({
    request: true,
    event: 'BufWritePre',
    arglist: [`+expand('<abuf>')`],
    callback: async (bufnr: number) => {
      let doc = Workspace.getDocument(bufnr)
      if (!doc || !doc.attached) return
      if (computeValidate(doc.textDocument) == Validate.off) return
      const config = Workspace.getConfiguration('eslint', doc.uri)
      if (config.get('autoFixOnSave', false)) {
        const params: CodeActionParams = {
          textDocument: {
            uri: doc.uri
          },
          range: Range.create(0, 0, doc.textDocument.lineCount, 0),
          context: {
            only: [`${CodeActionKind.SourceFixAll}.eslint`],
            diagnostics: []
          },
        }
        let res = await Promise.resolve(client.sendRequest(CodeActionRequest.type.method, params))
        if (res && Array.isArray(res)) {
          if (CodeAction.is(res[0])) {
            await Workspace.applyEdit(res[0].edit)
          }
        }
      }
    }
  })
  // client.registerProposedFeatures()

  Workspace.onDidChangeConfiguration(() => {
    probeFailed.clear()
    for (const textDocument of syncedDocuments.values()) {
      if (computeValidate(textDocument) === Validate.off) {
        try {
          const provider = (client as any).getFeature(DidCloseTextDocumentNotification.method).getProvider(textDocument)
          provider?.send(textDocument)
        } catch (err) {
          // A feature currently throws if no provider can be found. So for now we catch the exception.
        }
      }
    }
    for (const textDocument of Workspace.textDocuments) {
      if (!syncedDocuments.has(textDocument.uri.toString()) && computeValidate(textDocument) !== Validate.off) {
        try {
          const provider = (client as any).getFeature(DidOpenTextDocumentNotification.method).getProvider(textDocument)
          provider?.send(textDocument)
        } catch (err) {
          // A feature currently throws if no provider can be found. So for now we catch the exception.
        }
      }
    }
  })

  defaultErrorHandler = (client as any).createDefaultErrorHandler()
  client.onDidChangeState((event) => {
    if (event.newState === ClientState.Starting) {
      client.info('ESLint server is starting')
      serverRunning = undefined
    } else if (event.newState === ClientState.Running) {
      client.info(running)
      serverRunning = true
    } else {
      client.info(stopped)
      serverRunning = false
    }
    updateStatusBar(globalStatus ?? serverRunning === false ? Status.error : Status.ok, true)
  })
  client.onReady().then(() => {
    client.onNotification(ShowOutputChannel.type, () => {
      client.outputChannel.show()
    })

    client.onNotification(StatusNotification.type, (params) => {
      updateStatusInfo(params)
      updateStatusBarAndDiagnostics()
    })

    client.onNotification(exitCalled, (params) => {
      serverCalledProcessExit = true
      client.error(`Server process exited with code ${params[0]}. This usually indicates a misconfigured ESLint setup.`, params[1])
      Window.showErrorMessage(`ESLint server shut down itself. See 'ESLint' output channel for details.`, { title: 'Open Output', id: 1 }).then((value) => {
        if (value !== undefined && value.id === 1) {
          client.outputChannel.show()
        }
      })
    })

    client.onRequest(NoConfigRequest.type, (params) => {
      const uri = Uri.parse(params.document.uri)
      const workspaceFolder = Workspace.getWorkspaceFolder(params.document.uri)
      const fileLocation = uri.fsPath
      if (workspaceFolder) {
        client.warn([
          '',
          `No ESLint configuration (e.g .eslintrc) found for file: ${fileLocation}`,
          `File will not be validated. Consider running 'eslint --init' in the workspace folder ${workspaceFolder.name}`,
          `Alternatively you can disable ESLint by executing the 'Disable ESLint' command.`
        ].join('\n'))
      } else {
        client.warn([
          '',
          `No ESLint configuration (e.g .eslintrc) found for file: ${fileLocation}`,
          `File will not be validated. Alternatively you can disable ESLint by executing the 'Disable ESLint' command.`
        ].join('\n'))
      }

      let resourceInfo: ResourceInfo | undefined = resource2ResourceInfo.get(params.document.uri)
      if (resourceInfo === undefined) {
        resourceInfo = {
          status: Status.warn,
          executionInfo: undefined
        }
        resource2ResourceInfo.set(params.document.uri, resourceInfo)
      } else {
        resourceInfo.status = Status.warn
      }
      updateStatusBarAndDiagnostics()
      return {}
    })

    client.onRequest(NoESLintLibraryRequest.type, (params) => {
      const key = 'noESLintMessageShown'
      const state = context.globalState.get<NoESLintState>(key, {})

      const uri: Uri = Uri.parse(params.source.uri)
      const workspaceFolder = Workspace.getWorkspaceFolder(uri.toString())
      const packageManager = Workspace.getConfiguration('eslint', uri.toString()).get('packageManager', 'npm')
      const localInstall = {
        npm: 'npm install eslint',
        pnpm: 'pnpm install eslint',
        yarn: 'yarn add eslint',
      }
      const globalInstall = {
        npm: 'npm install -g eslint',
        pnpm: 'pnpm install -g eslint',
        yarn: 'yarn global add eslint'
      }
      const isPackageManagerNpm = packageManager === 'npm'
      interface ButtonItem extends MessageItem {
        id: number
      }
      const outputItem: ButtonItem = {
        title: 'Go to output',
        id: 1
      }
      if (workspaceFolder) {
        client.info([
          '',
          `Failed to load the ESLint library for the document ${uri.fsPath}`,
          '',
          `To use ESLint please install eslint by running ${localInstall[packageManager]} in the workspace folder ${workspaceFolder.name}`,
          `or globally using '${globalInstall[packageManager]}'. You need to reopen the workspace after installing eslint.`,
          '',
          isPackageManagerNpm ? 'If you are using yarn or pnpm instead of npm set the setting `eslint.packageManager` to either `yarn` or `pnpm`' : null,
          `Alternatively you can disable ESLint for the workspace folder ${workspaceFolder.name} by executing the 'Disable ESLint' command.`
        ].filter((str => (str !== null))).join('\n'))

        if (state.workspaces === undefined) {
          state.workspaces = {}
        }
        if (!state.workspaces[workspaceFolder.uri.toString()]) {
          state.workspaces[workspaceFolder.uri.toString()] = true
          context.globalState.update(key, state)
          Window.showInformationMessage(`Failed to load the ESLint library for the document ${uri.fsPath}. See the output for more information.`, outputItem).then((item) => {
            if (item && item.id === 1) {
              client.outputChannel.show(true)
            }
          })
        }
      } else {
        client.info([
          `Failed to load the ESLint library for the document ${uri.fsPath}`,
          `To use ESLint for single JavaScript file install eslint globally using '${globalInstall[packageManager]}'.`,
          isPackageManagerNpm ? 'If you are using yarn or pnpm instead of npm set the setting `eslint.packageManager` to either `yarn` or `pnpm`' : null,
          'You need to reopen VS Code after installing eslint.',
        ].filter((str => (str !== null))).join('\n'))

        if (!state.global) {
          state.global = true
          context.globalState.update(key, state)
          Window.showInformationMessage(`Failed to load the ESLint library for the document ${uri.fsPath}. See the output for more information.`, outputItem).then((item) => {
            if (item && item.id === 1) {
              client.outputChannel.show(true)
            }
          })
        }
      }
      return {}
    })

    client.onRequest(OpenESLintDocRequest.type, (params) => {
      Commands.executeCommand('vscode.open', Uri.parse(params.url))
      return {}
    })

    client.onRequest(ProbeFailedRequest.type, (params) => {
      probeFailed.add(params.textDocument.uri)
      const closeFeature = (client as any).getFeature(DidCloseTextDocumentNotification.method)
      for (const document of Workspace.textDocuments) {
        if (document.uri.toString() === params.textDocument.uri) {
          closeFeature.getProvider(document)?.send(document)
        }
      }
    })

    client.onRequest(ConfirmExecution.type, async (params): Promise<ConfirmExecutionResult> => {
      return confirmationSemaphore.lock(async () => {
        try {
          sessionState.set(params.libraryPath, params)
          let result: ConfirmExecutionResult | undefined
          if (disabledLibraries.has(params.libraryPath)) {
            result = ConfirmExecutionResult.disabled
          } else {
            const state = eslintExecutionState.libs[params.libraryPath]
            if (state === true || state === false) {
              clearDiagnosticState(params)
              result = state ? ConfirmExecutionResult.approved : ConfirmExecutionResult.denied
            } else if (eslintAlwaysAllowExecutionState === true) {
              clearDiagnosticState(params)
              result = ConfirmExecutionResult.approved

            }
          }
          result = result ?? ConfirmExecutionResult.confirmationPending
          let executionInfo: ExecutionInfo | undefined = libraryPath2ExecutionInfo.get(params.libraryPath)
          if (executionInfo === undefined) {
            executionInfo = {
              params: params,
              result: result,
              codeActionProvider: undefined,
              diagnostics: Languages.createDiagnosticCollection(),
              editorErrorUri: undefined
            }
            libraryPath2ExecutionInfo.set(params.libraryPath, executionInfo)
            const workspaceFolder = Workspace.getWorkspaceFolder(params.uri)
            if (workspaceFolder !== undefined) {
              const key = workspaceFolder.uri.toString()
              let infos = workspaceFolder2ExecutionInfos.get(key)
              if (infos === undefined) {
                infos = []
                workspaceFolder2ExecutionInfos.set(key, infos)
              }
              infos.push(executionInfo)
            }
          } else {
            executionInfo.result = result
          }
          let resourceInfo = resource2ResourceInfo.get(params.uri)
          if (resourceInfo === undefined) {
            resourceInfo = {
              status: ConfirmExecutionResult.toStatus(result),
              executionInfo: executionInfo
            }
            resource2ResourceInfo.set(params.uri, resourceInfo)
          } else {
            resourceInfo.status = ConfirmExecutionResult.toStatus(result)
          }
          updateStatusBarAndDiagnostics()
          return result
        } catch (err) {
          return ConfirmExecutionResult.denied
        }
      })
    })
  })

  if (onActivateCommands) {
    onActivateCommands.forEach(command => command.dispose())
    onActivateCommands = undefined
  }

  context.subscriptions.push(
    client.start(),
    events.on('BufEnter', () => {
      updateStatusBarAndDiagnostics()
    }),
    Workspace.registerTextDocumentContentProvider('eslint-error', {
      provideTextDocumentContent: () => {
        return [
          'ESLint is disabled since its execution has not been approved or rejected yet.',
          '',
          'When validating a file using ESLint, the ESLint NPM library will load customization files and code from your workspace',
          'and will execute it. If you do not trust the content in your workspace you should answer accordingly on the corresponding',
          'approval dialog.'
        ].join('\n')
      }
    }),
    Workspace.onDidCloseTextDocument((document) => {
      const uri = document.uri.toString()
      resource2ResourceInfo.delete(uri)
    }),
    Commands.registerCommand('eslint.executeAutofix', async () => {
      const doc = await Workspace.document
      if (!doc || !doc.attached) {
        return
      }
      const textDocument: VersionedTextDocumentIdentifier = {
        uri: doc.uri,
        version: doc.version
      }
      const params: ExecuteCommandParams = {
        command: 'eslint.applyAllFixes',
        arguments: [textDocument]
      }
      await client.onReady()
      client.sendRequest(ExecuteCommandRequest.type.method, params).then(undefined, () => {
        Window.showErrorMessage('Failed to apply ESLint fixes to the document. Please consider opening an issue with steps to reproduce.')
      })
    }),
    Commands.registerCommand('eslint.showOutputChannel', async () => {
      let doc = await Workspace.document
      const executionInfo = getExecutionInfo(doc, false)
      if (executionInfo !== undefined && (executionInfo.result === ConfirmExecutionResult.confirmationPending || executionInfo.result === ConfirmExecutionResult.disabled)) {
        await askForLibraryConfirmation(client, context, executionInfo.params, updateStatusBarAndDiagnostics)
        return
      }

      if (globalStatus === Status.ok || globalStatus === Status.warn || globalStatus === Status.error) {
        client.outputChannel.show()
        return
      }

      if (globalStatus === Status.executionDenied) {
        await resetLibraryConfirmations(client, context, updateStatusBarAndDiagnostics)
        return
      }

      let candidate: string | undefined
      let toRemove: Set<string> | Map<string, boolean> | undefined
      if (globalStatus === Status.confirmationPending) {
        if (libraryPath2ExecutionInfo.size === 1) {
          candidate = libraryPath2ExecutionInfo.keys().next().value
        }
      }
      if (globalStatus === Status.executionDisabled) {
        if (disabledLibraries.size === 1) {
          candidate = disabledLibraries.keys().next().value
          toRemove = disabledLibraries
        }
      }

      if (candidate !== undefined) {
        if (sessionState.has(candidate)) {
          if (toRemove !== undefined) {
            toRemove.delete(candidate)
          }
          await askForLibraryConfirmation(client, context, sessionState.get(candidate)!, updateStatusBarAndDiagnostics)
          return
        }
      }
      client.outputChannel.show()
    }),
    Commands.registerCommand('eslint.resetLibraryExecution', () => {
      resetLibraryConfirmations(client, context, updateStatusBarAndDiagnostics)
    }),
    Commands.registerCommand('eslint.manageLibraryExecution', async (params: ConfirmExecutionParams | undefined) => {
      if (params !== undefined) {
        await askForLibraryConfirmation(client, context, params, updateStatusBarAndDiagnostics)
      } else {
        let doc = await Workspace.document
        const info = getExecutionInfo(doc, false)
        if (info !== undefined) {
          await askForLibraryConfirmation(client, context, info.params, updateStatusBarAndDiagnostics)
        } else {
          Window.showInformationMessage(
            doc && doc.attached
              ? 'No ESLint library execution information found for current buffer.'
              : 'No ESLint library execution information found.')
        }
      }
    })
  )
}

export function deactivate() {
  if (onActivateCommands) {
    onActivateCommands.forEach(command => command.dispose())
  }
}
