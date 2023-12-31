Hooks.on('updateChatMessage', async (chatMessage) => {
  const isBlind = chatMessage.blind
  if (!chatMessage.flags.testData) return
  if (!isBlind || (isBlind && game.settings.get('wfrp4e-roll-tracker', 'count_hidden')) || (isBlind && chatMessage.user.isGM)) {
    await game.rollTracker.saveTrackedRoll(chatMessage.user.id, chatMessage)
  }
})

Hooks.on('createChatMessage', async (chatMessage) => {
  const isBlind = chatMessage.blind
  if (!isBlind || (isBlind && game.settings.get('wfrp4e-roll-tracker', 'count_hidden')) || (isBlind && chatMessage.user.isGM)) {
    if (chatMessage.isRoll && chatMessage.rolls[0]?.dice[0]?.faces === 100) {
      await game.rollTracker.saveSimpleRoll(chatMessage.user.id, chatMessage)
    } else {
      await game.rollTracker.saveReRoll(chatMessage.user.id, chatMessage)
    }
  }
})

// This adds our icon to the player list
Hooks.on('renderPlayerList', (playerList, html) => {
  if (game.user.isGM) {
    if (game.settings.get('wfrp4e-roll-tracker', 'gm_see_players')) {
      // This adds our icon to ALL players on the player list, if the setting is toggled
      const tooltip = game.i18n.localize('ROLL-TRACKER.button-title')
      // create the button where we want it to be
      for (let user of game.users) {
        const buttonPlacement = html.find(`[data-user-id="${user.id}"]`)
        buttonPlacement.append(`<button type="button" title='${tooltip}' class="roll-tracker-item-button flex0" id="${user.id}"><i class="fas fa-dice-d20"></i></button>`)
        html.on('click', `#${user.id}`, () => {
          new RollTrackerDialog(user.id).render(true);
        })
      }
    } else {
      // Put the roll tracker icon only beside the GM's name
      const loggedInUser = html.find(`[data-user-id="${game.userId}"]`)
      const tooltip = game.i18n.localize('ROLL-TRACKER.button-title')
      loggedInUser.append(`<button type="button" title='${tooltip}' class="roll-tracker-item-button flex0" id="${game.userId}"><i class="fas fa-dice-d20"></i></button>`)
      html.on('click', `#${game.userId}`, () => {
        new RollTrackerDialog(game.userId).render(true);
      })
    }
  } else if (game.settings.get('wfrp4e-roll-tracker', 'players_see_players')) {
    // find the element which has our logged in user's id
    const loggedInUser = html.find(`[data-user-id="${game.userId}"]`)
    const tooltip = game.i18n.localize('ROLL-TRACKER.button-title')
    loggedInUser.append(`<button type="button" title='${tooltip}' class="roll-tracker-item-button flex0" id="${game.userId}"><i class="fas fa-dice-d20"></i></button>`)
    html.on('click', `#${game.userId}`, () => {
      new RollTrackerDialog(game.userId).render(true);
    })
  }
})

// Register our module with the Dev Mode module, for logging purposes
Hooks.once('devModeReady', ({registerPackageDebugFlag}) => {
  registerPackageDebugFlag('wfrp4e-roll-tracker')
})

// Initialize dialog and settings on foundry boot up
Hooks.once('init', () => {
  game.rollTracker = new RollTracker();

  // A setting to toggle whether the GM can see the icon allowing them access to player roll data or not
  game.settings.register('wfrp4e-roll-tracker', 'gm_see_players', {
    name: `ROLL-TRACKER.settings.gm_see_players.Name`,
    default: true,
    type: Boolean,
    scope: 'world',
    config: true,
    hint: `ROLL-TRACKER.settings.gm_see_players.Hint`,
    onChange: () => ui.players.render()
  })

  // A setting to determine how many rolls should be stored at any one time
  game.settings.register('wfrp4e-roll-tracker', 'roll_storage', {
    name: `ROLL-TRACKER.settings.roll_storage.Name`,
    default: 50,
    type: Number,
    range: {
      min: -1,
      max: 500,
      step: 10
    },
    scope: 'world',
    config: true,
    hint: `ROLL-TRACKER.settings.roll_storage.Hint`,
  })

  // A setting to determine whether players can see their own tracked rolls
  game.settings.register('wfrp4e-roll-tracker', 'players_see_players', {
    name: `ROLL-TRACKER.settings.players_see_players.Name`,
    default: true,
    type: Boolean,
    scope: 'world',
    config: true,
    hint: `ROLL-TRACKER.settings.players_see_players.Hint`,
    onChange: () => ui.players.render()
  })

  // A setting to determine whether blind GM rolls that PLAYERS make are tracked
  // Blind GM rolls that GMs make are always tracked
  game.settings.register('wfrp4e-roll-tracker', 'count_hidden', {
    name: `ROLL-TRACKER.settings.count_hidden.Name`,
    default: true,
    type: Boolean,
    scope: 'world',
    config: true,
    hint: `ROLL-TRACKER.settings.count_hidden.Hint`,
  })
})


class RollTracker {
  getUserData(userId) {
    return {
      user: game.users.get(userId),
      data: game.users.get(userId)?.getFlag('wfrp4e-roll-tracker', 'data'),
      reroll: game.users.get(userId)?.getFlag('wfrp4e-roll-tracker', 'reroll'),
      export: game.users.get(userId)?.getFlag('wfrp4e-roll-tracker', 'export'),
    }
  }

  async saveReRoll(userId, chatMessage) {
    if (game.userId === userId) {
      let rerollData = this.getUserData(userId)?.reroll || {fortune: 0, fortuneSL: 0, darkDeal: 0}

      if (chatMessage.content.includes(game.i18n.localize("DARKDEAL.UsageText").replace("{character}", ""))) {
        rerollData.darkDeal++
      } else if (chatMessage.content.includes(game.i18n.localize("FORTUNE.UsageRerollText").replace("{character}", ""))) {
        rerollData.fortune++
      } else if (chatMessage.content.includes(game.i18n.localize("FORTUNE.UsageAddSLText").replace("{character}", ""))) {
        rerollData.fortuneSL++
      }

      return Promise.all([
        game.users.get(userId)?.setFlag('wfrp4e-roll-tracker', 'reroll', rerollData)
      ])
    }
  }

  async saveTrackedRoll(userId, chatMessage) {
    if (game.userId === userId) {
      let maxTrackedRolls = game.settings.get('wfrp4e-roll-tracker', 'roll_storage')
      let data = this.getUserData(userId)?.data || []

      // Message was processed earlier
      if (data.filter(r => r.id === chatMessage.id).length !== 0) return

      const messageResult = chatMessage.flags.testData.result
      const roll = {
        id: chatMessage.id,
        value: messageResult.roll,
        success: messageResult.outcome === "success",
        type: messageResult.skillName,
      }

      if (maxTrackedRolls > -1 && data.length >= maxTrackedRolls) {
        const difference = data.length - maxTrackedRolls
        for (let i = 0; i <= difference; i++) {
          data.shift()
        }
      }

      if (data.length) {
        data.push(roll)
      } else {
        data = [roll]
      }
      return Promise.all([
        game.users.get(userId)?.setFlag('wfrp4e-roll-tracker', 'data', data)
      ])
    }
  }

  async saveSimpleRoll(userId, chatMessage) {
    if (game.userId === userId) {
      let maxTrackedRolls = game.settings.get('wfrp4e-roll-tracker', 'roll_storage')
      let data = this.getUserData(userId)?.data || []

      // Message was processed earlier
      if (data.filter(r => r.id === chatMessage.id).length !== 0) return
      const roll = {
        id: chatMessage.id,
        value: chatMessage.rolls[0].total,
        success: undefined,
        type: "simple",
      }

      if (maxTrackedRolls > -1 && data.length >= maxTrackedRolls) {
        const difference = data.length - maxTrackedRolls
        for (let i = 0; i <= difference; i++) {
          data.shift()
        }
      }

      if (data.length) {
        data.push(roll)
      } else {
        data = [roll]
      }
      return Promise.all([
        game.users.get(userId)?.setFlag('wfrp4e-roll-tracker', 'data', data)
      ])
    }
  }

  async clearTrackedRolls(userId) {
    return Promise.all([
      game.users.get(userId)?.unsetFlag('wfrp4e-roll-tracker', 'export'),
      game.users.get(userId)?.unsetFlag('wfrp4e-roll-tracker', 'data'),
      game.users.get(userId)?.unsetFlag('wfrp4e-roll-tracker', 'reroll'),
    ])
  }

  prepareRollStats(userId) {
    const userRolls = this.getUserData(userId)
    const username = userRolls.user.name
    const rolls = userRolls.data

    let stats = {}
    if (!rolls) {
      stats.mean = 0
      stats.median = 0
      stats.mode = 0
      stats.modeCount = 0
      stats.modeCountPercentage = 0
      stats.count = 0
      stats.autoSuccess = 0
      stats.autoSuccessPercentage = 0
      stats.autoFailure = 0
      stats.autoFailurePercentage = 0
      stats.criticals = 0
      stats.criticalsPercentage = 0
      stats.fumbles = 0
      stats.fumblesPercentage = 0
    } else {
      stats = this.calcStats(rolls)
    }
    if (!userRolls.reroll) {
      stats.fortune = 0
      stats.fortuneSL = 0
      stats.darkDeal = 0
    } else {
      const {fortune, fortuneSL, darkDeal} = userRolls.reroll
      stats.fortune = fortune
      stats.fortuneSL = fortuneSL
      stats.darkDeal = darkDeal
    }

    return {
      username,
      userId,
      stats
    }
  }

  calcStats(rolls) {
    // D100
    const mean = calcAverage(rolls.map(r => r.value));
    const median = calcMedian(rolls.map(r => r.value));
    const {rollStats, mode, modeCount} = this.calcMode(rolls.map(r => r.value))
    const modeCountPercentage = (Math.round((modeCount / rolls.length) * 100))
    const lastRoll = rolls.map(r=>r.value).join(", ")
    const count = rolls.length

    // WFRP
    const autoSuccess = Object.entries(rollStats).reduce((acc, [key, value]) => {
      if (key <= game.settings.get("wfrp4e", "automaticSuccess")) return acc + value;return acc}, 0)
    const autoSuccessPercentage = (Math.round((autoSuccess / rolls.length) * 100))
    const autoFailure = Object.entries(rollStats).reduce((acc, [key, value]) => {
      if (key >= game.settings.get("wfrp4e", "automaticFailure")) return acc + value;return acc}, 0)
    const autoFailurePercentage = (Math.round((autoFailure / rolls.length) * 100))
    const criticals = rolls.reduce((acc, roll) => {
      if ((roll.value % 11 === 0 || roll.value === 100) && roll.success) return acc + 1;return acc}, 0)
    const criticalsPercentage = (Math.round((criticals / rolls.length) * 100))
    const fumbles = rolls.reduce((acc, roll) => {
      if ((roll.value % 11 === 0 || roll.value === 100) && !roll.success) return acc + 1;return acc}, 0)
    const fumblesPercentage = (Math.round((fumbles / rolls.length) * 100))

    this.prepareExportData(rollStats)

    return {
      mean,
      median,
      mode,
      modeCount,
      modeCountPercentage,
      autoSuccess,
      autoSuccessPercentage,
      autoFailure,
      autoFailurePercentage,
      criticals,
      criticalsPercentage,
      fumbles,
      fumblesPercentage,
      lastRoll,
      count
    }
  }

  calcMode(rolls) {
    let rollStats = {}
    let modeCount = 0
    let mode = 0

    rolls.forEach(e => {
      if (!rollStats[e]) {
        rollStats[e] = 1
      } else {
        rollStats[e]++
      }
    })
    for (let rollNumber in rollStats) {
      if (rollStats[rollNumber] > modeCount) {
        modeCount = rollStats[rollNumber]
        mode = rollNumber
      }
    }

    return {
      rollStats,
      mode,
      modeCount
    }
  }

  prepareExportData(data) {
    // prepare the roll data for export to an R-friendly text file
    const keys = Object.keys(data)
    let fileContent = ``
    for (let key of keys) {
      fileContent += `${key},${data[key]}\n`
    }
    // We store the filecontent on a flag on the user so it can be quickly accessed if the user
    // decides to click the export button on the RollTrackerDialog header
    game.users.get(game.userId)?.setFlag('wfrp4e-roll-tracker', 'export', fileContent)
  }

  /**
   * This function is meant to generate an overall picture across all players of rankings in the
   * various stats. Code exists to make the averages display alongside the individual player numbers
   * in the tracking card but I didn't like that
   **/
  async generalComparison() {
    let allStats = {}
    for (let user of game.users) {
      if (game.users.get(user.id)?.getFlag('wfrp4e-roll-tracker', 'data')) {
        const rolls = this.getUserData(user.id)?.data
        allStats[`${user.id}`] = this.calcStats(rolls)
      }
    }

    const comparators = await this.statsCompare(allStats, 'comparator')
    const means = await this.statsCompare(allStats, 'mean')
    const medians = await this.statsCompare(allStats, 'median')
    const autoSuccess = await this.statsCompare(allStats, 'autoSuccess')
    const autoSuccessPercentage = await this.statsCompare(allStats, 'autoSuccessPercentage')
    const autoFailure = await this.statsCompare(allStats, 'autoFailure')
    const autoFailurePercentage = await this.statsCompare(allStats, 'autoFailurePercentage')
    let finalComparison = {}
    this.prepStats(finalComparison, 'mean', means, allStats)
    this.prepStats(finalComparison, 'median', medians, allStats)
    this.prepStats(finalComparison, 'autoSuccess', autoSuccess, allStats)
    this.prepStats(finalComparison, 'autoSuccessPercentage', autoSuccessPercentage, allStats)
    this.prepStats(finalComparison, 'autoFailure', autoFailure, allStats)
    this.prepStats(finalComparison, 'autoFailurePercentage', autoFailurePercentage, allStats)
    this.prepMode(finalComparison, 'comparator', comparators, allStats)

    return finalComparison
  }

  /**
   * A general function to compare incoming 'stats' using a specific data object in the format
   * generated in the allStats variable of generalComparison()
   */
  async statsCompare(allStats, stat) {
    let topStat = -1;
    let comparison = {}
    for (let user in allStats) {
      if (allStats[`${user}`][stat] > topStat) {
        topStat = allStats[`${user}`][stat]
        comparison.top = [user]
      } else if (allStats[`${user}`][stat] === topStat) {
        comparison.top.push(user)
      }
    }

    if (stat !== 'comparator') {
      let botStat = 9999;
      for (let user in allStats) {
        if (allStats[`${user}`][stat] < botStat) {
          botStat = allStats[`${user}`][stat]
          comparison.bot = [user]
        } else if (allStats[`${user}`][stat] === botStat) {
          comparison.bot.push(user)
        }
      }

      let statSum = 0
      for (let user in allStats) {
        statSum += allStats[`${user}`][stat]
      }
      comparison.average = Math.round(statSum / (Object.keys(allStats).length))
    } else {
      topStat = -1;
      for (let user in allStats) {
        let percentage = Math.round(((allStats[`${user}`][stat]) / (allStats[`${user}`].count)) * 100)
        if (percentage > topStat) {
          topStat = percentage
          comparison.topPercentage = [user]
        } else if (percentage === topStat) {
          comparison.topPercentage.push(user)
        }
      }
    }

    return comparison
  }

  /**
   * A function preparing the output object of generalComparison (the obj is called finalComparison)
   * using previously calculated stats
   */
  async prepStats(finalComparison, statName, statObj, allStats) {

    finalComparison[statName] = {}
    finalComparison[statName].highest = []
    finalComparison[statName].lowest = []

    for (let user of statObj.top) {
      const userStats = {}
      userStats.userId = `${user}`
      userStats.name = game.users.get(`${user}`)?.name
      userStats.value = allStats[`${user}`][statName]
      userStats.rolls = allStats[`${user}`].count
      finalComparison[statName].highest.push(userStats)
    }

    for (let user of statObj.bot) {
      const userStats = {}
      userStats.userId = `${user}`
      userStats.name = game.users.get(`${user}`)?.name
      userStats.value = allStats[`${user}`][statName]
      userStats.rolls = allStats[`${user}`].count
      finalComparison[statName].lowest.push(userStats)
    }

    finalComparison[statName].average = statObj.average
  }

  /**
   * Mode has its own way to be prepped as it can be multimodal etc
   */
  async prepMode(finalComparison, comparator, comparators, allStats) {
    finalComparison[comparator] = {}
    finalComparison[comparator].highest = {}
    for (let user of comparators.top) {
      finalComparison[comparator].highest.userId = `${user}`
      finalComparison[comparator].highest.name = game.users.get(`${user}`)?.name
      const mode = allStats[`${user}`].mode
      let modeString = mode.join(', ')
      if (mode.length > 1) {
        const orPosn = modeString.lastIndexOf(',')
        const firstHalf = modeString.slice(0, orPosn)
        const secondHalf = modeString.slice(orPosn + 1)
        modeString = firstHalf.concat(' or', secondHalf)
      }
      finalComparison[comparator].highest.mode = modeString
      finalComparison[comparator].highest.value = allStats[`${user}`][comparator]
      finalComparison[comparator].highest.rolls = allStats[`${user}`].count
      finalComparison[comparator].highest.percentage = Math.round((((finalComparison[comparator].highest.value) / (finalComparison[comparator].highest.rolls))) * 100)
    }
    finalComparison[comparator].highestPercentage = {}
    for (let user of comparators.topPercentage) {
      finalComparison[comparator].highestPercentage.userId = `${user}`
      finalComparison[comparator].highestPercentage.name = game.users.get(`${user}`)?.name
      const mode = allStats[`${user}`].mode
      let modeString = mode.join(', ')
      if (mode.length > 1) {
        const orPosn = modeString.lastIndexOf(',')
        const firstHalf = modeString.slice(0, orPosn)
        const secondHalf = modeString.slice(orPosn + 1)
        modeString = firstHalf.concat(', or', secondHalf)
      }
      finalComparison[comparator].highestPercentage.mode = modeString
      finalComparison[comparator].highestPercentage.value = allStats[`${user}`][comparator]
      finalComparison[comparator].highestPercentage.rolls = allStats[`${user}`].count
      finalComparison[comparator].highestPercentage.percentage = Math.round((((finalComparison[comparator].highestPercentage.value) / (finalComparison[comparator].highestPercentage.rolls))) * 100)
    }
  }
}

class RollTrackerDialog extends FormApplication {
  constructor(userId, options = {}) {
    super(userId, options)
    console.log(game.users.get(userId)?.getFlag('wfrp4e-roll-tracker', 'data'))
  }

  static get defaultOptions() {
    const defaults = super.defaultOptions
    const overrides = {
      height: 'auto',
      width: '400',
      id: 'wfrp4e-roll-tracker',
      template: `modules/wfrp4e-roll-tracker/templates/roll-tracker.hbs`,
    }
    return foundry.utils.mergeObject(defaults, overrides)
  }

  get exportData() {
    return game.rollTracker.getUserData(game.userId)?.export
  }

  async getData() {
    const rollData = game.rollTracker.prepareRollStats(this.object)
    this.options.title = `${rollData.username}: Roll Tracker`
    return rollData
  }

  async prepCompCard() {
    let comparison = await game.rollTracker.generalComparison()
    let content = await renderTemplate(`modules/wfrp4e-roll-tracker/templates/roll-tracker-comparison-card.hbs`, comparison)
    ChatMessage.create({content})
  }

  activateListeners(html) {
    super.activateListeners(html);
    html.on('click', "[data-action]", this._handleButtonClick.bind(this))
  }

  async _handleButtonClick(event) {
    const clickedElement = $(event.currentTarget)
    const action = clickedElement.data().action
    const userId = clickedElement.parents(`[data-userId]`)?.data().userid
    switch (action) {
      case 'clear': {
        const confirmed = await Dialog.confirm({
          title: game.i18n.localize("ROLL-TRACKER.confirms.clear_rolls.title"),
          content: game.i18n.localize("ROLL-TRACKER.confirms.clear_rolls.content"),
        })
        if (confirmed) {
          await game.rollTracker.clearTrackedRolls(userId)
          this.render();
        }
        break
      }
      case 'print': {
        const rollData = game.rollTracker.prepareRollStats(this.object)
        const content = await renderTemplate(`modules/wfrp4e-roll-tracker/templates/roll-tracker-chat.hbs`, rollData)
        ChatMessage.create({content})
      }
    }
  }

  _getHeaderButtons() {
    let buttons = super._getHeaderButtons();
    buttons.splice(0, 0, {
      class: "roll-tracker-form-export",
      icon: "fas fa-download",
      onclick: () => {
        if (this.exportData) {
          saveDataToFile(this.exportData, 'string', 'roll-data.txt')
        } else {
          return ui.notifications.warn("No roll data to export")
        }
      }
    })
    if (game.user.isGM) {
      buttons.splice(1, 0, {
        class: "roll-tracker-form-comparison",
        icon: "fas fa-chart-simple",
        onclick: () => {
          // this.prepCompCard()
        }
      })
    }
    return buttons
  }
}


function calcAverage(list) {
  const sum = list.reduce((firstValue, secondValue) => {
    return firstValue + secondValue
  })
  return Math.round(sum / list.length);
}

function calcMedian(list) {
  list = list.sort((a, b) => a - b)
  if (list.length % 2 === 1) {
    let medianPosition = Math.floor(list.length / 2)
    return list[medianPosition]
  } else {
    let beforeMedian = (list.length / 2)
    let afterMedian = beforeMedian + 1
    return (list[beforeMedian - 1] + list[afterMedian - 1]) / 2
  }
}