const Clutter = imports.gi.Clutter
const Lang = imports.lang
const Cinnamon = imports.gi.Cinnamon
const St = imports.gi.St
const Main = imports.ui.main
const Tweener = imports.ui.tweener
const PopupMenu = imports.ui.popupMenu
const Signals = imports.signals
const DND = imports.ui.dnd
const _ = imports.applet._
const clog = imports.applet.clog

// Load our applet so we can access other files in our extensions dir as libraries
const AppletDir = imports.ui.appletManager.applets['IcingTaskManager@json']
const App = AppletDir.applet
const SpecialMenus = AppletDir.specialMenus
const SpecialButtons = AppletDir.specialButtons

function AppGroup () {
  this._init.apply(this, arguments)
}

/*



MyApplet._init, signal (switch-workspace) -> _onSwitchWorkspace -> AppList._init, on_orientation_changed  -> _refreshList -> _loadFavorites, _refreshApps -> _windowAdded -> AppGroup



*/

AppGroup.prototype = {
  __proto__: Object.prototype,
  _init: function (applet, appList, app, isFavapp) {
    if (DND.LauncherDraggable) {
      DND.LauncherDraggable.prototype._init.call(this)
    }
    this._applet = applet
    this.appList = appList

    this._deligate = this
    // This convert the applet class in a launcherBox (is requiered to be a launcher dragable object)
    // but you have duplicate object this._applet then... // TBD
    this.launchersBox = applet;
    this.app = app
    this.isFavapp = isFavapp
    this.isNotFavapp = !isFavapp
    this.orientation = applet.orientation
    this.metaWindows = []
    this.metaWorkspaces = {}
    this.actor = new St.Bin({
      reactive: true,
      can_focus: true,
      x_fill: true,
      y_fill: false,
      track_hover: true
    })
    this.actor._delegate = this

    this.myactor = new St.BoxLayout({
      reactive: true
    })
    this.actor.set_child(this.myactor)

    this._appButton = new SpecialButtons.AppButton(this)

    this.myactor.add(this._appButton.actor)

    this._appButton.actor.connect('button-release-event', Lang.bind(this, this._onAppButtonRelease))

    // Set up the right click menu for this._appButton
    this.rightClickMenu = new SpecialMenus.AppMenuButtonRightClickMenu(this, this._appButton.actor)
    this._menuManager = new PopupMenu.PopupMenuManager(this)
    this._menuManager.addMenu(this.rightClickMenu)

    // Set up the hover menu for this._appButton
    this.hoverMenu = new SpecialMenus.AppThumbnailHoverMenu(this)
    this._hoverMenuManager = new SpecialMenus.HoverMenuController(this)
    this._hoverMenuManager.addMenu(this.hoverMenu)

    this._draggable = SpecialButtons.makeDraggable(this.actor)
    this._draggable.connect('drag-cancelled', Lang.bind(this, this._onDragCancelled))
    this._draggable.connect('drag-end', Lang.bind(this, this._onDragEnd))
    this.isDraggableApp = true

    this.on_panel_edit_mode_changed()
    this.on_arrange_pinned()
    global.settings.connect('changed::panel-edit-mode', Lang.bind(this, this.on_panel_edit_mode_changed))
    this._applet.settings.connect('changed::arrange-pinnedApps', Lang.bind(this, this.on_arrange_pinned))
  },

  getId: function () {
    return this.app.get_id()
  },

  on_arrange_pinned: function () {
    this._draggable.inhibit = !this._applet.settings.getValue('arrange-pinnedApps')
  },

  on_panel_edit_mode_changed: function () {
    this._draggable.inhibit = global.settings.get_boolean('panel-edit-mode')
    this.actor.reactive = !global.settings.get_boolean('panel-edit-mode')
  },

  on_title_display_changed: function (metaWindow) {
    this._windowTitleChanged(metaWindow)
    let titleType = this._applet.settings.getValue('title-display')
    if (titleType === App.TitleDisplay.Title) {
      this.showAppButtonLabel(true)
    } else if (titleType === App.TitleDisplay.App) {
      this.showAppButtonLabel(true)
    } else if (titleType === App.TitleDisplay.None) {
      this.hideAppButtonLabel(true)
    }
  },

  _onDragEnd: function () {
    this.rightClickMenu.close(false)
    this.hoverMenu.close(false)
    this.appList.myactorbox._clearDragPlaceholder()
  },

  _onDragCancelled: function () {
    this.rightClickMenu.close(false)
    this.hoverMenu.close(false)
    this.appList.myactorbox._clearDragPlaceholder()
  },

  handleDragOver: function (source, actor, x, y, time) {
    let IsLauncherDraggable = null
    if (DND.LauncherDraggable) {
      IsLauncherDraggable = source instanceof DND.LauncherDraggable
    }
    if (source instanceof AppGroup || source.isDraggableApp || IsLauncherDraggable) {
      return DND.DragMotionResult.CONTINUE
    }

    if (typeof (this.appList.dragEnterTime) == 'undefined') {
      this.appList.dragEnterTime = time
    } else {
      if (time > (this.appList.dragEnterTime + 3000)) {
        this.appList.dragEnterTime = time
      }
    }

    if (time > (this.appList.dragEnterTime + 300) && !(this.isFavapp || source.isDraggableApp)) {
      this._windowHandle(true)
    }
    return true
  },

  getDragActor: function () {
    return this.app.create_icon_texture(this._applet._panelHeight)
  },

  // Returns the original actor that should align with the actor
  // we show as the item is being dragged.
  getDragActorSource: function () {
    return this.actor
  },

  _setWatchedWorkspaces: function () {
    this._appButton._setWatchedWorkspaces(this.metaWorkspaces)
  },

  // Add a workspace to the list of workspaces that are watched for
  // windows being added and removed
  watchWorkspace: function (metaWorkspace) {
    if (!this.metaWorkspaces[metaWorkspace]) {
      // We use connect_after so that the window-tracker time to identify the app, otherwise get_window_app might return null!
      let windowAddedSignal = metaWorkspace.connect_after('window-added', Lang.bind(this, this._windowAdded))
      let windowRemovedSignal = metaWorkspace.connect_after('window-removed', Lang.bind(this, this._windowRemoved))
      this.metaWorkspaces[metaWorkspace] = {
        workspace: metaWorkspace,
        signals: [windowAddedSignal, windowRemovedSignal]
      }
    }
    this._calcWindowNumber(metaWorkspace)
    this._applet.settings.connect('changed::number-display', ()=>{
      this._calcWindowNumber(metaWorkspace)
    })
    this._setWatchedWorkspaces()
  },

  // Stop monitoring a workspace for added and removed windows.
  // @metaWorkspace: if null, will remove all signals
  unwatchWorkspace: function (metaWorkspace) {
    function removeSignals (obj) {
      let signals = obj.signals
      for (let i = 0; i < signals.length; i++) {
        obj.workspace.disconnect(signals[i])
      }
    }

    if (!metaWorkspace) {
      for (let k in this.metaWorkspaces) {
        removeSignals(this.metaWorkspaces[k])
        delete this.metaWorkspaces[k]
      }
    } else if (this.metaWorkspaces[metaWorkspace]) {
      removeSignals(this.metaWorkspaces[metaWorkspace])
      delete this.metaWorkspaces[metaWorkspace]
    } else {
      global.log('Warning: tried to remove watch on an unwatched workspace')
    }
    this._setWatchedWorkspaces()
  },

  hideAppButton: function () {
    this._appButton.actor.hide()
  },

  showAppButton: function () {
    this._appButton.actor.show()
  },

  hideAppButtonLabel: function (animate) {
    this._appButton.hideLabel(animate)
  },

  showAppButtonLabel: function (animate, targetWidth) {
    this._appButton.showLabel(animate, targetWidth)
  },

  _onAppButtonRelease: function (actor, event) {
    var button = event.get_button();
    if ((button === 1) && this.isFavapp) {
      this.app.open_new_window(-1)
      this._animate()
      return
    }
    var appWindows = this.app.get_windows();

    var handleMinimizeToggle = (win)=>{
      if (win.appears_focused) {
        win.minimize()
      } else {
        this.app.activate(win, global.get_current_time())
      }
    };

    if (button === 1) {
      this.hoverMenu.shouldOpen = false;
      if (appWindows.length === 1) {
        handleMinimizeToggle(appWindows[0]);
      } else {
        var actionTaken = false
        for (let i = appWindows.length - 1; i >= 0; i--) {
          if (this.lastFocused && appWindows[i]._lgId === this.lastFocused._lgId) {
            handleMinimizeToggle(appWindows[i])
            actionTaken = true
            break
          }
        }
        if (!actionTaken) {
          handleMinimizeToggle(appWindows[0]);
        }
      }
      
    } else if (button === 2) {
      for (let i = appWindows.length - 1; i >= 0; i--) {
        handleMinimizeToggle(appWindows[i])
      }
    }
  },

  _newAppKeyNumber: function (number) {
    if (this.hotKeyId) {
      Main.keybindingManager.removeHotKey(this.hotKeyId)
    }
    if (number < 10) {
      Main.keybindingManager.addHotKey('launch-app-key-' + number.toString(), '<Super>' + number.toString(), Lang.bind(this, this._onAppKeyPress))
      Main.keybindingManager.addHotKey('launch-new-app-key-' + number.toString(), '<Super><Shift>' + number.toString(), Lang.bind(this, this._onNewAppKeyPress))
      this.hotKeyId = 'launch-app-key-' + number.toString()
    }
  },

  _onAppKeyPress: function () {
    if (this.isFavapp) {
      this.app.open_new_window(-1)
      this._animate()
    } else {
      this._windowHandle(false)
    }
  },

  _onNewAppKeyPress: function (number) {
    this.app.open_new_window(-1)
    this._animate()
  },

  _windowHandle: function (fromDrag) {
    let has_focus = this.lastFocused.has_focus()
    if (!this.lastFocused.minimized && !has_focus) {
      this.lastFocused.foreach_transient(function (child) {
        if (!child.minimized && child.has_focus()) {
          has_focus = true
        }
      })
    }

    if (has_focus) {
      if (fromDrag) {
        return
      }
      this.lastFocused.minimize(global.get_current_time())
      this.actor.remove_style_pseudo_class('focus')
    } else {
      if (this.lastFocused.minimized) {
        this.lastFocused.unminimize(global.get_current_time())
      }
      let ws = this.lastFocused.get_workspace().index()
      if (ws != global.screen.get_active_workspace_index()) {
        global.screen.get_workspace_by_index(ws).activate(global.get_current_time())
      }
      Main.activateWindow(this.lastFocused, global.get_current_time())
      this.actor.add_style_pseudo_class('focus')
    }
  },
  _getLastFocusedWindow: function () {
    // Get a list of windows and sort it in order of last access
    /*let list = []
    for (let i = 0, len = this.metaWindows.length; i < len; i++) {
      list.push([ this.metaWindows[i].win.user_time, this.metaWindows[i].win])
    }
    list.sort(function (a, b) {
      return a[0] - b[0]
    })

    if (list[0]) {
      return list[0][1]
    } else {
      return null
    }*/
    return _.orderBy(this.metaWindows, 'win.user_time')
  },

  // updates the internal list of metaWindows
  // to include all windows corresponding to this.app on the workspace
  // metaWorkspace
  _updateMetaWindows: function (metaWorkspace) {
    let tracker = Cinnamon.WindowTracker.get_default()
    // Get a list of all interesting windows that are part of this app on the current workspace
    var windowList = _.filter(metaWorkspace.list_windows(), (win)=>{
      try {
        let app = App.appFromWMClass(this.appList._appsys, this.appList.specialApps, win)
        if (!app) {
          app = tracker.get_window_app(win)
        }
        return app == this.app && tracker.is_window_interesting(win) && Main.isInteresting(win)
      } catch (e) {
        return false
      }
    })

    this.metaWindows = []



    for (let i = 0, len = windowList.length; i < len; i++) {
      this._windowAdded(metaWorkspace, windowList[i])
    }

    // When we first populate we need to decide which window
    // will be triggered when the app button is pressed
    if (!this.lastFocused) {
      this.lastFocused = this._getLastFocusedWindow()
    }
    if (this.lastFocused) {
      this._windowTitleChanged(this.lastFocused)
      this.rightClickMenu.setMetaWindow(this.lastFocused)
    }
  },

  _windowAdded: function (metaWorkspace, metaWindow) {
    let tracker = Cinnamon.WindowTracker.get_default()
    let app = App.appFromWMClass(this.appList._appsys, this.appList.specialApps, metaWindow)
    if (!app) {
      app = tracker.get_window_app(metaWindow)
    }


    var refWindow = _.findIndex(this.metaWindows, (win)=>{
      return _.isEqual(win.win, metaWindow)
    })

    if (app == this.app && refWindow === -1 && tracker.is_window_interesting(metaWindow)) {
      if (metaWindow) {
        this.lastFocused = metaWindow
        this.rightClickMenu.setMetaWindow(this.lastFocused)
        this.hoverMenu.setMetaWindow(this.lastFocused)
      }

      let signals = []

      this._applet.settings.connect('changed::title-display', ()=>{
        this.on_title_display_changed(metaWindow)
        this._windowTitleChanged(metaWindow)
      })

      signals.push(metaWindow.connect('notify::title', Lang.bind(this, this._windowTitleChanged)))
      signals.push(metaWindow.connect('notify::appears-focused', Lang.bind(this, this._focusWindowChange)))

      let data = {
        signals: signals
      }

      this.metaWindows.push({
        win: metaWindow, 
        data: data
      })

      if (this.isFavapp) {
        this._isFavorite(false)
      }
      this._calcWindowNumber(metaWorkspace)
    }
    if (app && app.wmClass && !this.isFavapp) {
      this._calcWindowNumber(metaWorkspace)
    }
  },

  _windowRemoved: function (metaWorkspace, metaWindow) {
    let deleted

    var refWindow = _.findIndex(this.metaWindows, (win)=>{
      return _.isEqual(win.win, metaWindow)
    })

    if (refWindow !== -1) {
      deleted = this.metaWindows[refWindow].data
    }
    if (deleted) {
      let signals = deleted.signals
      // Clean up all the signals we've connected
      for (let i = 0, len = signals.length; i < len; i++) {
        metaWindow.disconnect(signals[i])
      }

      this.metaWindows = _.without(this.metaWindows, refWindow)
      _.pullAt(this.metaWindows, refWindow)

      if (this.metaWindows.length > 0) {
        this.lastFocused = _.last(this.metaWindows).win
        this._windowTitleChanged(this.lastFocused)
        this.hoverMenu.setMetaWindow(this.lastFocused)
        this.rightClickMenu.setMetaWindow(this.lastFocused)

        this._calcWindowNumber(metaWorkspace)
      }
    }
    let app = App.appFromWMClass(this.appList._appsys, this.appList.specialApps, metaWindow)
    if (app && app.wmClass && !this.isFavapp) {
      this._calcWindowNumber(metaWorkspace)
    }
  },

  _windowTitleChanged: function (metaWindow) {
    // We only really want to track title changes of the last focused app
    if (!this._appButton) {
      throw 'Error: got a _windowTitleChanged callback but this._appButton is undefined'
    }
    if (metaWindow != this.lastFocused || this.isFavapp) {
      return
    }
    let titleType = this._applet.settings.getValue('title-display')

    var title = metaWindow.get_title()
    var appName = this.app.get_name()

    if (titleType === App.TitleDisplay.Title) {
      if (title) {
        this._appButton.setText(title)
        this.showAppButtonLabel(true)
      }
    } else if (titleType === App.TitleDisplay.Focused) {
      if (title) {
        this._appButton.setText(title)
        this._updateFocusedStatus(true)
      }
    } else if (titleType === App.TitleDisplay.App) {
      if (appName) {
        this._appButton.setText(appName)
        this.showAppButtonLabel(true)
      }
    } else if (titleType === App.TitleDisplay.None) {
      this._appButton.setText('')
    }
  },

  _focusWindowChange: function (metaWindow) {
    if (metaWindow.appears_focused) {
      this.lastFocused = metaWindow
      this._windowTitleChanged(this.lastFocused)
      if (this._applet.sortThumbs === true) {
        this.hoverMenu.setMetaWindow(this.lastFocused)
      }
      this.rightClickMenu.setMetaWindow(this.lastFocused)
    }
    if (this._applet.settings.getValue('title-display') === App.TitleDisplay.Focused) {
      this._updateFocusedStatus()
    }
  },

  _updateFocusedStatus: function (force) {
    let focusState
    for (let i = 0, len = this.metaWindows.length; i < len; i++) {
      if (this.metaWindows[i].win.appears_focused) {
        focusState = this.metaWindows[i].win
        break
      }
    }
    if (this.focusState != focusState || force) {
      this._focusedLabel(focusState)
    }
    this.focusState = focusState
  },

  _focusedLabel: function (focusState) {
    if (focusState) {
      this.showAppButtonLabel(true)
    } else {
      this.hideAppButtonLabel(true)
    }
  },

  _isFavorite: function (isFav) {
    this.isFavapp = isFav
    this.wasFavapp = !(isFav)
    this._appButton._isFavorite(isFav)
    this.rightClickMenu.removeItems()
    this.rightClickMenu._isFavorite(isFav)
    this.hoverMenu.appSwitcherItem._isFavorite(isFav)
    this._windowTitleChanged(this.lastFocused)
  },

  _calcWindowNumber: function (metaWorkspace) {
    if (!this._appButton) {
      clog('Error: got a _calcWindowNumber callback but this._appButton is undefined')
    }
    let windowNum = this.metaWindows.length
    //windowNum = this.appList._getNumberOfAppWindowsInWorkspace(this.app, metaWorkspace)
    let numDisplay = this._applet.settings.getValue('number-display')
    this._appButton._numLabel.text = windowNum.toString()
    if (numDisplay === App.NumberDisplay.Smart) {
      if (windowNum <= 1) {
        this._appButton._numLabel.hide()
      } else {
        this._appButton._numLabel.show()
      }
    } else if (numDisplay == App.NumberDisplay.Normal) {
      if (windowNum <= 0) {
        this._appButton._numLabel.hide()
      }
      else {
        this._appButton._numLabel.show()
      }
    } else if (numDisplay == App.NumberDisplay.All) {
      this._appButton._numLabel.show()
    } else {
      this._appButton._numLabel.hide()
    }
  },

  _animate: function () {
    this.actor.set_z_rotation_from_gravity(0.0, Clutter.Gravity.CENTER)
    Tweener.addTween(this.actor, {
      opacity: 70,
      time: 1.0,
      transition: 'linear',
      onCompleteScope: this,
      onComplete: function () {
        Tweener.addTween(this.actor, {
          opacity: 255,
          time: 0.5,
          transition: 'linear'
        })
      }
    })
  },

  destroy: function () {
    // Unwatch all workspaces before we destroy all our actors
    // that callbacks depend on

    var destroyWindowSignal = (metaWindow)=>{
      for (let i = 0, len = metaWindow.data.signals.length; i < len; i++) {
        metaWindow.win.disconnect(metaWindow.data.signals[i])
      }
    }

    for (let i = 0, len = this.metaWindows.length; i < len; i++) {
      destroyWindowSignal(this.metaWindows[i])
    }

    this.unwatchWorkspace(null)
    this.rightClickMenu.destroy()
    this.hoverMenu.destroy()
    this._appButton.destroy()
    this.myactor.destroy()
    this.actor.destroy()
  }
}
Signals.addSignalMethods(AppGroup.prototype)