// The application menu.
//
// Until this existed overdb ran on Electron's default menu, whose Help
// submenu links to Electron's own website and whose About box names
// Electron. A menu is where people look when they are stuck, so this is
// where the app's explanations of itself live: how it works, the keyboard
// shortcuts, and the sample database for anyone who wants to see it working
// before pointing it at their own servers.
//
// Edit, View and Window keep Electron's standard roles — copy and paste in
// every text field depend on the Edit menu existing on macOS.

import { Menu, shell, type MenuItemConstructorOptions } from 'electron';
import type { MenuCommand } from '../shared/types';

const REPO = 'https://github.com/overcodelions/overdb';

export function installMenu(send: (command: MenuCommand) => void): void {
  const isMac = process.platform === 'darwin';

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: 'overdb',
            submenu: [
              { label: 'About overdb', click: () => send('about') },
              { type: 'separator' },
              { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => send('settings') },
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' },
            ],
          } satisfies MenuItemConstructorOptions,
        ]
      : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Connection…', click: () => send('newConnection') },
        { label: 'Import Connections…', click: () => send('importConnections') },
        { label: 'New Environment Set…', click: () => send('newEnvSet') },
        { type: 'separator' },
        {
          label: 'Go to…',
          accelerator: 'CmdOrCtrl+K',
          // Shown, not registered: the window binds ⌘K itself, and a
          // registered accelerator would fire twice and toggle it shut.
          registerAccelerator: false,
          click: () => send('palette'),
        },
        ...(isMac
          ? ([{ type: 'separator' }, { role: 'close' }] as MenuItemConstructorOptions[])
          : ([
              { type: 'separator' },
              { label: 'Settings…', accelerator: 'Ctrl+,', click: () => send('settings') },
              { type: 'separator' },
              { role: 'quit' },
            ] as MenuItemConstructorOptions[])),
      ],
    },
    {
      label: 'Edit',
      submenu: [
        // Shown but not registered: the SQL editor keeps its own undo
        // history, and the native one would reach past it.
        { role: 'undo', accelerator: 'CmdOrCtrl+Z', registerAccelerator: false },
        { role: 'redo', accelerator: 'Shift+CmdOrCtrl+Z', registerAccelerator: false },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        ...(isMac
          ? ([{ role: 'pasteAndMatchStyle' }, { role: 'delete' }, { role: 'selectAll' }] as MenuItemConstructorOptions[])
          : ([{ role: 'delete' }, { type: 'separator' }, { role: 'selectAll' }] as MenuItemConstructorOptions[])),
      ],
    },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        { label: 'How overdb Works', click: () => send('basics') },
        {
          label: 'Keyboard Shortcuts',
          accelerator: 'CmdOrCtrl+/',
          // Shown, not registered: the window binds it and skips it inside
          // the SQL editor, where ⌘/ toggles a comment.
          registerAccelerator: false,
          click: () => send('shortcuts'),
        },
        { label: 'Try the Sample Database', click: () => send('sample') },
        { type: 'separator' },
        { label: 'Changelog', click: () => void shell.openExternal(`${REPO}/blob/master/CHANGELOG.md`) },
        { label: 'Report an Issue', click: () => void shell.openExternal(`${REPO}/issues/new/choose`) },
        ...(isMac
          ? []
          : ([{ type: 'separator' }, { label: 'About overdb', click: () => send('about') }] as MenuItemConstructorOptions[])),
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
