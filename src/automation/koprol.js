const { Builder, By, until, Key } = require("selenium-webdriver");
const chrome = require("selenium-webdriver/chrome");
const fs = require("fs");
const path = require("path");
const config = require("../utils/config");
const logger = require("../utils/logger");
const {
  guessTitle,
  guessHelpdeskNote,
  guessBobot,
} = require("../utils/ticketAnalysis");

class KoprolAutomation {
  constructor() {
    this.driver = null;
    this.isLoggedIn = false;
  }

  xpathLiteral(text = "") {
    const str = `${text}`;
    if (!str.includes("'")) {
      return `'${str}'`;
    }
    const parts = str.split("'");
    const concat = parts
      .map((part) => `'${part}'`)
      .join(`, "\"'\"", `);
    return `concat(${concat})`;
  }

  async selectBobotDropdown(modal, value) {
    if (!value) return false;
    let row;
    try {
      row = await modal.findElement(
        By.xpath(
          ".//tr[.//label[contains(normalize-space(.), 'Bobot')] or .//td[contains(normalize-space(.), 'Bobot')] or .//td[contains(normalize-space(.), 'Difficulty')]]"
        )
      );
    } catch (e) {
      return false;
    }

    let input = null;
    const inputs = await row.findElements(
      By.css("input.o_input.ui-autocomplete-input, .o_input_dropdown input.o_input, input")
    );
    if (inputs.length) {
      input = inputs[0];
    }
    if (!input) return false;

    await this.scrollIntoView(input);
    try {
      await input.click();
    } catch (e) {}
    await this.driver.sleep(150);

    try {
      await input.clear().catch(() => {});
    } catch (e) {}
    await input.sendKeys(value);
    await this.driver.sleep(300);

    // Confirm selection to avoid o_field_invalid
    try {
      await input.sendKeys(Key.RETURN);
      await this.driver.sleep(350);
      return true;
    } catch (e) {
      return false;
    }
  }

  async selectUrgencyDropdown(scope, value) {
    if (!value) return false;
    let row = null;
    try {
      row = await scope.findElement(
        By.xpath(
          ".//*[self::tr or self::div][.//label[contains(translate(normalize-space(.),'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'urgency') or contains(translate(normalize-space(.),'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'urgensi')] or .//td[contains(translate(normalize-space(.),'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'urgency') or contains(translate(normalize-space(.),'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'urgensi')] or .//*[@data-fieldname='urgency']]"
        )
      );
    } catch (e) {}
    if (!row) {
      try {
        row = await scope.findElement(By.css("[data-fieldname='urgency']"));
      } catch (e) {
        return false;
      }
    }

    // Prefer explicit dropdown button
    let btn = null;
    const dropdownBtns = await row.findElements(
      By.css(".o_dropdown_button, .fa-chevron-down, .fa-caret-down, button")
    );
    if (dropdownBtns.length) {
      btn = dropdownBtns[0];
    }

    // If no button, try input directly
    const inputs = await row.findElements(
      By.css("input.o_input, input[type='text'], input:not([type])")
    );

    if (btn) {
      await this.scrollIntoView(btn);
      try {
        await btn.click();
      } catch (e) {}
      await this.driver.sleep(200);
    } else if (inputs.length) {
      // No dropdown button, go straight to input
      try {
        await this.scrollIntoView(inputs[0]);
        await inputs[0].click();
      } catch (e) {}
    }

    // Attempt pick from opened menu
    const itemXpath = `//div[contains(@class,'o_menu_opened')]//a[normalize-space(.)='${value}'] | //ul[contains(@class,'dropdown-menu') and contains(@class,'show')]//a[normalize-space(.)='${value}']`;
    try {
      const item = await this.driver.findElement(By.xpath(itemXpath));
      await item.click();
      await this.driver.sleep(250);
      return true;
    } catch (e) {}

    // Fallback: type then Enter
    if (inputs.length) {
      const input = inputs[0];
      await this.scrollIntoView(input).catch(() => {});
      try {
        await input.click();
      } catch (e) {}
      try {
        await input.clear();
      } catch (e) {}
      await input.sendKeys(value);
      await this.driver.sleep(200);
      try {
        await input.sendKeys(Key.RETURN);
        await this.driver.sleep(250);
      } catch (e) {}
      return true;
    }

    return false;
  }

  async initialize() {
    try {
      const options = new chrome.Options();

      if (config.selenium.headless) {
        options.addArguments("--headless");
      }

      options.addArguments("--disable-gpu");
      options.addArguments("--no-sandbox");
      options.addArguments("--disable-dev-shm-usage");
      options.addArguments("--window-size=1920,1080");

      this.driver = await new Builder()
        .forBrowser("chrome")
        .setChromeOptions(options)
        .build();

      logger.info("Selenium WebDriver initialized");
      return true;
    } catch (error) {
      logger.error("Failed to initialize WebDriver", error);
      throw error;
    }
  }

  async isOnLoginPage() {
    if (!this.driver) return false;
    try {
      const url = await this.driver.getCurrentUrl();
      if (url && url.includes("/web/login")) {
        return true;
      }
    } catch (e) {}

    try {
      const loginInputs = await this.driver.findElements(
        By.css(
          'form[action*="/web/login"], input[name="login"], input[placeholder="Email"], input[type="email"]'
        )
      );
      if (loginInputs.length) {
        return true;
      }
    } catch (e) {}

    return false;
  }

  async login() {
    if (this.isLoggedIn) {
      logger.info("Already logged in to Koprol");
      return true;
    }

    try {
      if (!this.driver) {
        await this.initialize();
      }

      logger.info(`Navigating to ${config.koprol.url}/web/login`);
      await this.driver.get(`${config.koprol.url}/web/login`);

      // Wait for any email/login input to appear
      await this.driver.wait(
        until.elementLocated(
          By.css(
            'input[name="login"], input[placeholder="Email"], input[type="email"], input[type="text"]'
          )
        ),
        10000
      );

      // Find email/login field with fallbacks
      let emailField;
      try {
        emailField = await this.driver.findElement(
          By.css('input[name="login"]')
        );
      } catch (e1) {
        emailField = await this.driver.findElement(
          By.css(
            'input[placeholder="Email"], input[type="email"], input[type="text"]'
          )
        );
      }

      // Find password field with fallbacks
      let passwordField;
      try {
        passwordField = await this.driver.findElement(
          By.css('input[name="password"]')
        );
      } catch (e2) {
        passwordField = await this.driver.findElement(
          By.css('input[placeholder="Password"], input[type="password"]')
        );
      }

      await emailField.clear();
      await emailField.sendKeys(config.koprol.username);
      await passwordField.clear();
      await passwordField.sendKeys(config.koprol.password);

      // Click login button (avoid :contains which is invalid in CSS)
      let loginButton;
      try {
        loginButton = await this.driver.findElement(
          By.css('button[type="submit"]')
        );
      } catch (e3) {
        loginButton = await this.driver.findElement(
          By.xpath(
            "//button[contains(., 'Log in') or contains(., 'Login') or contains(., 'Sign in')]"
          )
        );
      }
      await loginButton.click();
      await this.driver.sleep(1000);

      // Wait until we are no longer on the login page and backend UI is visible
      const loginTimeoutMs = 20000;
      const startTs = Date.now();
      while (Date.now() - startTs < loginTimeoutMs) {
        const stillOnLogin = await this.isOnLoginPage();
        if (!stillOnLogin) break;
        await this.driver.sleep(500);
      }

      if (await this.isOnLoginPage()) {
        throw new Error("Masih di halaman login setelah submit kredensial");
      }

      try {
        await this.driver.wait(
          until.elementLocated(
            By.css(".o_main_navbar, .o_control_panel, .o_web_client")
          ),
          15000
        );
      } catch (e) {}

      this.isLoggedIn = true;
      logger.info("Successfully logged in to Koprol");
      return true;
    } catch (error) {
      logger.error("Login failed", error);
      throw new Error("Gagal login ke Koprol. Periksa kredensial di .env");
    }
  }

  async waitForAnyCss(selectors, timeout = 15000) {
    const start = Date.now();
    let lastErr = null;
    while (Date.now() - start < timeout) {
      for (const sel of selectors) {
        try {
          const el = await this.driver.findElement(By.css(sel));
          if (await el.isDisplayed()) {
            return el;
          }
        } catch (e) {
          lastErr = e;
        }
      }
      await this.driver.sleep(250);
    }
    throw lastErr || new Error("Element not found: " + selectors.join(" | "));
  }

  async waitUntilSelectorsGone(selectors = [], timeout = 10000) {
    if (!selectors.length) return true;
    const start = Date.now();
    while (Date.now() - start < timeout) {
      let anyVisible = false;
      for (const sel of selectors) {
        const elements = await this.driver.findElements(By.css(sel));
        for (const el of elements) {
          try {
            if (await el.isDisplayed()) {
              anyVisible = true;
              break;
            }
          } catch (e) {}
        }
        if (anyVisible) break;
      }
      if (!anyVisible) {
        return true;
      }
      await this.driver.sleep(200);
    }
    return false;
  }

  async dismissAnyModal(timeout = 4000) {
    const modalSelectors = [
      ".modal.show",
      ".o_dialog_container .modal-content",
      ".o_legacy_dialog.modal.show",
    ];
    const btnSelectors = [
      "button.btn-primary",
      "button.btn-secondary",
      "button.btn",
      ".btn-primary",
      ".btn-secondary",
    ];

    const start = Date.now();
    while (Date.now() - start < timeout) {
      const modals = await this.driver.findElements(By.css(modalSelectors.join(",")));
      if (!modals.length) return true;
      for (const modal of modals) {
        let clicked = false;
        for (const bs of btnSelectors) {
          const btns = await modal.findElements(By.css(bs));
          if (btns.length) {
            try {
              await btns[0].click();
              clicked = true;
              break;
            } catch (e) {}
          }
        }
        if (!clicked) {
          try {
            const closes = await modal.findElements(By.css(".close, .o_close_button, [data-dismiss='modal']"));
            if (closes.length) {
              await closes[0].click();
            }
          } catch (e) {}
        }
      }
      await this.waitUntilSelectorsGone(modalSelectors, 1500);
      await this.driver.sleep(150);
    }
    return true;
  }

  async waitForPageReady() {
    try {
      await this.driver.wait(
        until.elementLocated(By.css(".o_control_panel, .o_searchview")),
        15000
      );
    } catch (e) {}
    await this.driver.sleep(300);
  }

  async waitForUrlContains(fragment, timeout = 10000) {
    try {
      await this.driver.wait(until.urlContains(fragment), timeout);
    } catch (e) {}
  }

  async getSearchInputForTitle(titleText) {
    // Find the control panel whose breadcrumb contains the given title
    const cp = await this.driver.findElement(
      By.xpath(
        `//div[contains(@class,'o_control_panel')][.//ol[contains(@class,'breadcrumb')]//li[contains(normalize-space(.), '${titleText}')]]`
      )
    );
    // Within that control panel, find the search input
    try {
      return await cp.findElement(
        By.css("div.o_searchview_input_container input")
      );
    } catch (e1) {}
    try {
      return await cp.findElement(By.css("input.o_searchview_input"));
    } catch (e2) {}
    try {
      return await cp.findElement(
        By.css('input[placeholder="Search..."], input[type="search"]')
      );
    } catch (e3) {}
    throw new Error("Request Form search input not found");
  }

  async isRequestFormListVisible() {
    const listEls = await this.driver.findElements(
      By.css("table.o_list_table, .o_list_renderer")
    );
    if (!listEls.length) return false;
    const breadcrumb = await this.driver.findElements(
      By.xpath(
        "//div[contains(@class,'o_control_panel')]//ol[contains(@class,'breadcrumb')]//li[contains(normalize-space(.), 'Request Form')]"
      )
    );
    return breadcrumb.length > 0;
  }

  async selectJrfMenuOption(optionText) {
    const menuTriggerXPaths = [
      "//nav//*[self::a or self::button][contains(@class,'dropdown') or contains(@class,'o_menu_entry')][contains(normalize-space(.), 'JRF/ARF')]",
      "//a[contains(@class,'dropdown-toggle')][contains(., 'JRF/ARF')]",
      "//button[contains(., 'JRF/ARF')]",
    ];
    for (const xp of menuTriggerXPaths) {
      const els = await this.driver.findElements(By.xpath(xp));
      if (els.length) {
        try {
          await els[0].click();
          await this.driver.sleep(200);
          break;
        } catch (e) {}
      }
    }
    const optionXpath = `//a[normalize-space(.)='${optionText}' or contains(normalize-space(.), '${optionText}')]`;
    const options = await this.driver.findElements(By.xpath(optionXpath));
    if (options.length) {
      try {
        await options[0].click();
        await this.driver.sleep(400);
        return true;
      } catch (e) {}
    }
    return false;
  }

  async fillTitleFieldInAssignModal(modal, value) {
    if (!value) return false;
    let row;
    try {
      row = await modal.findElement(
        By.xpath(
          ".//tr[.//label[contains(normalize-space(.), 'Title')] or .//td[contains(normalize-space(.), 'Title')] ]"
        )
      );
    } catch (e) {
      return false;
    }

    const candidates = await row.findElements(
      By.css(
        "[data-fieldname='title'] input, input[name='title'], input[type='text'], input:not([type])"
      )
    );
    if (!candidates.length) return false;

    let input = null;
    for (const el of candidates) {
      try {
        const ro = (await el.getAttribute('readonly')) || '';
        const dis = (await el.getAttribute('disabled')) || '';
        if (ro || dis) continue;
        const typeAttr = (await el.getAttribute('type')) || 'text';
        if (typeAttr === 'hidden') continue;
        const display = (await el.getCssValue('display')) || '';
        const visibility = (await el.getCssValue('visibility')) || '';
        const opacity = parseFloat(((await el.getCssValue('opacity')) || '1'));
        const rect = await el.getRect();
        if (display === 'none' || visibility === 'hidden' || opacity === 0 || rect.height < 2 || rect.width < 2) {
          continue;
        }
        input = el;
        break;
      } catch (e) {}
    }
    if (!input) return false;

    await this.scrollIntoView(input);
    await input.click();
    await this.driver.sleep(100);
    await input.clear().catch(() => {});
    await input.sendKeys(value);
    await this.driver.sleep(200);
    return true;
  }

  async clickAssignButton() {
    const xpathCandidates = [
      `//div[contains(@class,"o_form_statusbar")]//button[contains(translate(normalize-space(.),"abcdefghijklmnopqrstuvwxyz","ABCDEFGHIJKLMNOPQRSTUVWXYZ"),"ASSIGN")]`,
      `//header//button[contains(translate(normalize-space(.),"abcdefghijklmnopqrstuvwxyz","ABCDEFGHIJKLMNOPQRSTUVWXYZ"),"ASSIGN")]`,
    ];
    let btn = null;
    for (const xp of xpathCandidates) {
      const found = await this.driver.findElements(By.xpath(xp));
      if (found.length) {
        btn = found[0];
        break;
      }
    }
    if (!btn) {
      const clicked = await this.clickActionMenuItem([
        "Assign",
        "Assignment",
        "Tugaskan",
        "Penugasan",
      ]);
      if (clicked) {
        await this.driver.sleep(800);
        return true;
      }
      return false;
    }
    try {
      await btn.click();
    } catch (e) {
      return false;
    }
    await this.driver.sleep(600);
    return true;
  }

  async clickStartButtonRobust() {
    const labels = ["Start", "Mulai", "Start Ticket", "Start Task"];
    let btn = null;

    // 1) Prefer Start button inside the currently open modal (e.g. "Open: Request")
    try {
      const modal = await this.getLatestModal();
      for (const lab of labels) {
        const xp = `.//*[self::button or self::a][contains(translate(normalize-space(.),"abcdefghijklmnopqrstuvwxyz","ABCDEFGHIJKLMNOPQRSTUVWXYZ"),"${lab.toUpperCase()}")]`;
        const found = await modal.findElements(By.xpath(xp));
        if (found.length) {
          btn = found[0];
          break;
        }
      }
    } catch (e) {}

    // 2) Fallback: global statusbar/header search
    if (!btn) {
      const xpathCandidates = [
        `//div[contains(@class,"o_form_statusbar")]//button[contains(translate(normalize-space(.),"abcdefghijklmnopqrstuvwxyz","ABCDEFGHIJKLMNOPQRSTUVWXYZ"),"START")]`,
        `//header//button[contains(translate(normalize-space(.),"abcdefghijklmnopqrstuvwxyz","ABCDEFGHIJKLMNOPQRSTUVWXYZ"),"START")]`,
      ];
      for (const xp of xpathCandidates) {
        const found = await this.driver.findElements(By.xpath(xp));
        if (found.length) {
          btn = found[0];
          break;
        }
      }
    }

    // 3) Fallback: action menu item
    if (!btn) {
      const clicked = await this.clickActionMenuItem(labels);
      if (clicked) {
        await this.driver.sleep(1200);
        return true;
      }
      return false;
    }

    try {
      await this.scrollIntoView(btn);
    } catch (e) {}
    try {
      await btn.click();
    } catch (e) {
      return false;
    }
    await this.driver.sleep(1200);
    return true;
  }

  async clickFormButton({
    labels = [],
    names = [],
    allowDropdown = false,
    waitMs = 800,
  } = {}) {
    const xpathCandidates = [];
    for (const name of names) {
      xpathCandidates.push(
        `//div[contains(@class,'o_form_statusbar')]//button[@name='${name}']`
      );
      xpathCandidates.push(`//header//button[@name='${name}']`);
      xpathCandidates.push(
        `//div[contains(@class,'o_form_buttons_view')]//button[@name='${name}']`
      );
      xpathCandidates.push(
        `//div[contains(@class,'o_form_buttons_edit')]//button[@name='${name}']`
      );
      xpathCandidates.push(
        `//div[contains(@class,'o_control_panel')]//button[@name='${name}']`
      );
    }

    for (const label of labels) {
      const upper = (label || "").toUpperCase();
      const labelXPath = `contains(translate(normalize-space(.),"abcdefghijklmnopqrstuvwxyz","ABCDEFGHIJKLMNOPQRSTUVWXYZ"),"${upper}")`;
      xpathCandidates.push(
        `//div[contains(@class,'o_form_statusbar')]//button[${labelXPath}]`
      );
      xpathCandidates.push(`//header//button[${labelXPath}]`);
      xpathCandidates.push(
        `//div[contains(@class,'o_form_buttons_view')]//button[${labelXPath}]`
      );
      xpathCandidates.push(
        `//div[contains(@class,'o_form_buttons_edit')]//button[${labelXPath}]`
      );
      xpathCandidates.push(
        `//div[contains(@class,'o_control_panel')]//button[${labelXPath}]`
      );
    }

    for (const xp of xpathCandidates) {
      const found = await this.driver.findElements(By.xpath(xp));
      if (found.length) {
        const btn = found[0];
        try {
          await this.scrollIntoView(btn);
        } catch (e) {}
        try {
          await btn.click();
          await this.driver.sleep(waitMs);
          return true;
        } catch (e) {
          try {
            await this.driver.executeScript("arguments[0].click();", btn);
            await this.driver.sleep(waitMs);
            return true;
          } catch (err) {}
        }
      }
    }

    if (allowDropdown && labels.length) {
      const clicked = await this.clickActionMenuItem(labels);
      if (clicked) {
        await this.driver.sleep(waitMs);
        return true;
      }
    }

    return false;
  }

  async clickEditButton() {
    return await this.clickFormButton({
      labels: ["Edit", "Ubah"],
      names: ["edit"],
      allowDropdown: true,
      waitMs: 600,
    });
  }

  async clickSaveButton() {
    return await this.clickFormButton({
      labels: ["Save", "Simpan"],
      names: ["save_button"],
      allowDropdown: true,
      waitMs: 900,
    });
  }

  async clickDoneButton() {
    return await this.clickFormButton({
      labels: ["Done", "Selesai"],
      names: ["action_done", "done"],
      allowDropdown: true,
      waitMs: 1200,
    });
  }

  async clickSetDueDateButton() {
    return await this.clickFormButton({
      labels: ["Set Due Date", "Due Date"],
      names: ["set_due_date"],
      allowDropdown: true,
      waitMs: 600,
    });
  }

  async openOutstandingTaskList() {
    if (!this.driver) {
      throw new Error("WebDriver belum siap");
    }
    const outstandingUrl = `${config.koprol.url}/web#action=428&model=eps.request.form.line&view_type=list&menu_id=301`;
    const maxAttempts = 2;
    const listSelectors = [
      "table.o_list_table",
      ".o_list_view table.o_list_table",
      ".o_list_renderer table",
      ".o_list_table.o_list_view",
    ];
    const blockingSelectors = [
      ".o_loading",
      ".o_loading_indicator",
      ".o_planner_loading",
      ".o_blockUI",
      ".o_dialog_container .o_spinner",
    ];

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      logger.info(
        `Opening Outstanding Task list (attempt ${attempt}): ${outstandingUrl}`
      );
      await this.driver.get(outstandingUrl);

      try {
        await this.waitForPageReady();
        await this.waitUntilSelectorsGone(blockingSelectors, 12000);

        // Occasionally a modal (e.g., warning) blocks the list. Close generic modals if present.
        const modals = await this.driver.findElements(By.css(".modal-content"));
        if (modals.length) {
          for (const modal of modals) {
            try {
              const buttons = await modal.findElements(
                By.css("button.btn-primary, button.btn-secondary, button.btn")
              );
              if (buttons.length) {
                await buttons[0].click();
                await this.driver.sleep(200);
              }
            } catch (e) {}
          }
          await this.waitUntilSelectorsGone(
            [".modal-content", ".o_dialog_container"],
            5000
          );
        }

        const listElement = await this.waitForAnyCss(listSelectors, 25000);
        if (listElement) {
          try {
            await this.scrollIntoView(listElement);
          } catch (e) {}
        }
        await this.driver.sleep(400);
        return true;
      } catch (e) {
        logger.warn("Outstanding Task list failed to load", {
          message: e.message,
        });
      }
    }
    throw new Error("Outstanding Task list tidak bisa dibuka");
  }

  async scrapeOutstandingTasks(picName, maxRows = 10) {
    const table = await this.driver.findElement(By.css("table.o_list_table"));
    const headerEls = await table.findElements(By.css("thead tr th"));
    const headers = [];
    for (const headerEl of headerEls) {
      let headerText = "";
      try {
        headerText = (await headerEl.getText()).trim();
      } catch (e) {}
      headers.push(headerText || `col_${headers.length}`);
    }

    const rows = await table.findElements(By.css("tbody tr"));
    const tasks = [];
    const normalizedPic = (picName || "").trim().toLowerCase();

    for (const row of rows) {
      const cells = await row.findElements(By.css("td"));
      if (!cells.length) continue;

      const rowData = {};
      for (let i = 0; i < cells.length && i < headers.length; i++) {
        let text = "";
        try {
          text = (await cells[i].getText()).trim();
        } catch (e) {}
        rowData[headers[i]] = text;
      }

      const picValue =
        rowData["PIC"] ||
        rowData["Pic"] ||
        rowData["pic"] ||
        rowData["Assigned to"] ||
        "";
      if (
        normalizedPic &&
        (!picValue || !picValue.toLowerCase().includes(normalizedPic))
      ) {
        continue;
      }

      tasks.push({
        ticket:
          rowData["Name"] ||
          rowData["Nomor"] ||
          rowData["Request Form"] ||
          rowData[headers[0]] ||
          "",
        request: rowData["Request"] || "",
        user: rowData["User Request"] || rowData["Requester"] || "",
        assignDate: rowData["Assign Date"] || rowData["Date"] || "",
        state: rowData["State"] || "",
        clock: rowData["Clocking State"] || rowData["Clock"] || "",
        pic: (picValue || "").trim(),
      });

      if (tasks.length >= maxRows) break;
    }

    return tasks;
  }

  async fetchOutstandingTasks(picName, maxRows = 10) {
    await this.initialize();
    await this.login();
    await this.openOutstandingTaskList();
    return await this.scrapeOutstandingTasks(picName, maxRows);
  }

  async findOutstandingRow(ticketIdentifier) {
    const safeTicket = this.xpathLiteral(ticketIdentifier.trim());
    const rowXpath = `//table[contains(@class,'o_list_table')]//tr[contains(@class,'o_data_row')][.//span[contains(normalize-space(.), ${safeTicket})] or .//td[contains(normalize-space(.), ${safeTicket})]]`;
    const rows = await this.driver.findElements(By.xpath(rowXpath));
    if (rows.length) {
      return rows[0];
    }
    return null;
  }

  async breakOutstandingTicket(ticketIdentifier, reasonText) {
    if (!ticketIdentifier) {
      throw new Error("Nomor tiket untuk Break tidak diberikan");
    }
    const reason = (reasonText || "").trim();
    if (!reason) {
      throw new Error("Alasan Break tidak boleh kosong");
    }

    await this.initialize();
    await this.login();
    await this.openOutstandingTaskList();

    const row = await this.findOutstandingRow(ticketIdentifier);
    if (!row) {
      throw new Error(`Tidak menemukan tiket ${ticketIdentifier} di Outstanding Task`);
    }

    let breakBtn = null;
    const breakButtons = await row.findElements(
      By.xpath(".//button[contains(normalize-space(.), 'Break')]")
    );
    for (const btn of breakButtons) {
      const label = (await btn.getText()).trim().toLowerCase();
      if (label === "break") {
        breakBtn = btn;
        break;
      }
    }
    if (!breakBtn && breakButtons.length) {
      breakBtn = breakButtons[0];
    }
    if (!breakBtn) {
      throw new Error("Tombol Break tidak ditemukan pada baris tiket ini");
    }

    try {
      await this.scrollIntoView(breakBtn);
    } catch (e) {}

    await breakBtn.click();
    await this.driver
      .wait(until.elementLocated(By.css(".modal-content")), 5000)
      .catch(() => {});
    await this.driver.sleep(300);

    const modal = await this.getLatestModal();

    let reasonInput = null;
    const reasonSelectors = [
      "textarea[name*='reason']",
      "textarea[name*='break']",
      "input[name*='reason']",
      "input[name*='break']",
    ];
    for (const sel of reasonSelectors) {
      const inputs = await modal.findElements(By.css(sel));
      if (inputs.length) {
        reasonInput = inputs[0];
        break;
      }
    }
    if (!reasonInput) {
      const textareas = await modal.findElements(By.css("textarea"));
      if (textareas.length) {
        reasonInput = textareas[0];
      }
    }
    if (!reasonInput) {
      const inputs = await modal.findElements(
        By.css("input[type='text'], input:not([type])")
      );
      if (inputs.length) {
        reasonInput = inputs[0];
      }
    }
    if (!reasonInput) {
      throw new Error("Kolom Alasan Break tidak ditemukan");
    }

    await this.scrollIntoView(reasonInput).catch(() => {});
    await reasonInput.click();
    try {
      await reasonInput.clear();
    } catch (e) {}
    try {
      await reasonInput.sendKeys(Key.chord(Key.CONTROL, "a"));
      await reasonInput.sendKeys(Key.BACK_SPACE);
    } catch (e) {}
    await reasonInput.sendKeys(reason);

    await this.clickButtonInModal(modal, "Break");
    try {
      await this.driver.wait(until.stalenessOf(modal), 5000);
    } catch (e) {}
    await this.driver.sleep(500);

    return true;
  }

  async endBreakOutstandingTicket(ticketIdentifier) {
    if (!ticketIdentifier) {
      throw new Error("Nomor tiket untuk End Break tidak diberikan");
    }

    await this.initialize();
    await this.login();
    await this.openOutstandingTaskList();

    const row = await this.findOutstandingRow(ticketIdentifier);
    if (!row) {
      throw new Error(`Tidak menemukan tiket ${ticketIdentifier} di Outstanding Task`);
    }

    let endBreakBtn = null;
    const btnCandidates = await row.findElements(
      By.xpath(
        ".//button[contains(translate(normalize-space(.),'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'end break')]"
      )
    );
    for (const btn of btnCandidates) {
      const label = (await btn.getText()).trim().toLowerCase();
      if (label.includes("end break")) {
        endBreakBtn = btn;
        break;
      }
    }
    if (!endBreakBtn && btnCandidates.length) {
      endBreakBtn = btnCandidates[0];
    }
    if (!endBreakBtn) {
      throw new Error("Tombol End Break tidak ditemukan pada baris tiket ini");
    }

    try {
      await this.scrollIntoView(endBreakBtn);
    } catch (e) {}

    await endBreakBtn.click();

    let modal = null;
    try {
      await this.driver
        .wait(until.elementLocated(By.css(".modal-content")), 2500)
        .catch(() => {});
      modal = await this.getLatestModal();
    } catch (e) {
      modal = null;
    }

    if (modal) {
      const confirmLabels = ["End Break", "END BREAK", "Confirm", "Ya", "OK"];
      let clicked = false;
      for (const label of confirmLabels) {
        try {
          await this.clickButtonInModal(modal, label);
          clicked = true;
          break;
        } catch (e) {}
      }
      if (!clicked) {
        // If no labeled button found, try default primary button
        try {
          const primaryBtn = await modal.findElement(
            By.css("button.btn-primary, button.btn-danger, button.btn-info")
          );
          await primaryBtn.click();
        } catch (e) {}
      }
      try {
        await this.driver.wait(until.stalenessOf(modal), 5000);
      } catch (e) {}
    }

    await this.driver.sleep(500);
    return true;
  }

  async completeOutstandingTicket(ticketIdentifier, closing = {}) {
    if (!ticketIdentifier) {
      throw new Error("Nomor tiket untuk Done tidak diberikan");
    }

    const closingData = {
      impact: closing.impact || "",
      urgency: closing.urgency || "",
      rca: (closing.rca || "").trim(),
      solution: (closing.solution || "").trim(),
      dueDate: closing.dueDate || null,
      dueInDays: closing.dueInDays || 1,
    };

    if (!closingData.rca) {
      throw new Error("RCA wajib diisi sebelum menutup tiket");
    }
    if (!closingData.solution) {
      throw new Error("Solusi wajib diisi sebelum menutup tiket");
    }

    await this.initialize();
    await this.login();
    await this.openOutstandingTaskList();

    const row = await this.findOutstandingRow(ticketIdentifier);
    if (!row) {
      throw new Error(
        `Tidak menemukan tiket ${ticketIdentifier} di Outstanding Task`
      );
    }

    try {
      await this.scrollIntoView(row);
    } catch (e) {}

    let rowOpened = false;
    try {
      await this.driver
        .actions({ bridge: true })
        .move({ origin: row })
        .doubleClick()
        .perform();
      rowOpened = true;
    } catch (e) {}

    if (!rowOpened) {
      try {
        await row.click();
        await this.driver.sleep(150);
        await this.driver
          .actions({ bridge: true })
          .move({ origin: row })
          .doubleClick()
          .perform();
        rowOpened = true;
      } catch (e) {}
    }

    if (!rowOpened) {
      try {
        await row.click();
        await this.driver.sleep(150);
        await this.driver
          .actions({ bridge: true })
          .sendKeys(Key.RETURN)
          .perform();
        rowOpened = true;
      } catch (e) {}
    }

    if (!rowOpened) {
      throw new Error(
        "Gagal membuka form tiket dari daftar Outstanding (double click gagal)"
      );
    }

    await this.waitForFormView();

    const editClicked = await this.clickEditButton();
    if (!editClicked) {
      throw new Error("Tombol Edit tidak ditemukan pada form tiket");
    }

    await this.driver.sleep(400);

    let formRoot = null;
    try {
      formRoot = await this.driver.findElement(
        By.css(".o_form_view, .o_form_renderer, .o_form_sheet")
      );
    } catch (e) {
      formRoot = await this.driver.findElement(By.css("body"));
    }

    if (closingData.impact) {
      const impactFilled = await this.safeSelectDropdownInModal(
        formRoot,
        ["Impact"],
        closingData.impact
      );
      if (!impactFilled) {
        throw new Error("Field Impact tidak ditemukan");
      }
    }

    if (closingData.urgency) {
      let urgencyFilled = false;
      // Try dedicated dropdown helper (click + enter)
      try {
        urgencyFilled = await this.selectUrgencyDropdown(
          formRoot,
          closingData.urgency
        );
      } catch (e) {}

      // Fallback: generic dropdown selector
      if (!urgencyFilled) {
        try {
          urgencyFilled = await this.safeSelectDropdownInModal(
            formRoot,
            ["Urgency", "Urgensi"],
            closingData.urgency
          );
        } catch (e) {}
      }

      // Fallback: direct input field by data-fieldname
      if (!urgencyFilled) {
        try {
          urgencyFilled = await this.fillTextFieldByFieldNameAttr(
            formRoot,
            ["urgency"],
            closingData.urgency
          );
        } catch (e) {}
      }

      if (!urgencyFilled) {
        logger.warn("Field Urgency tidak ditemukan, melewati pengisian urgency");
      }
    }

    // RCA: utamakan input dengan name="rca" (Problem Detail), lalu fieldname/label.
    let rcaFilled = false;
    for (let attempt = 0; attempt < 3 && !rcaFilled; attempt++) {
      await this.dismissAnyModal(2500);
      try {
        const rcaInputs = await formRoot.findElements(
          By.css("input[name='rca'], textarea[name='rca']")
        );
        if (rcaInputs.length) {
          const rcaInput = rcaInputs[0];
          await this.scrollIntoView(rcaInput).catch(() => {});
          try {
            await rcaInput.click();
          } catch (e) {}
          try {
            await rcaInput.clear();
          } catch (e) {}
          await rcaInput.sendKeys(closingData.rca);
          rcaFilled = true;
          break;
        }
      } catch (e) {}

      if (!rcaFilled) {
        try {
          rcaFilled = await this.fillTextFieldByFieldNameAttr(
            formRoot,
            ["rca", "root_cause", "root_cause_analysis"],
            closingData.rca
          );
        } catch (e) {}
      }

      if (!rcaFilled) {
        rcaFilled = await this.safeFillTextFieldInModal(
          formRoot,
          ["RCA", "Root Cause", "Root Cause Analysis"],
          closingData.rca
        );
      }
    }
    if (!rcaFilled) {
      throw new Error("Field RCA tidak ditemukan atau tidak dapat diisi");
    }

    // Solution: utamakan input dengan name="solution", lalu fieldname/label.
    let solutionFilled = false;
    for (let attempt = 0; attempt < 3 && !solutionFilled; attempt++) {
      await this.dismissAnyModal(2500);
      try {
        const solInputs = await formRoot.findElements(
          By.css("input[name='solution'], textarea[name='solution']")
        );
        if (solInputs.length) {
          const solInput = solInputs[0];
          await this.scrollIntoView(solInput).catch(() => {});
          try {
            await solInput.click();
          } catch (e) {}
          try {
            await solInput.clear();
          } catch (e) {}
          await solInput.sendKeys(closingData.solution);
          solutionFilled = true;
          break;
        }
      } catch (e) {}

      if (!solutionFilled) {
        try {
          solutionFilled = await this.fillTextFieldByFieldNameAttr(
            formRoot,
            ["solution", "solusi", "action_taken", "fix"],
            closingData.solution
          );
        } catch (e) {}
      }

      if (!solutionFilled) {
        solutionFilled = await this.safeFillTextFieldInModal(
          formRoot,
          ["Solution", "Solusi", "Action Taken", "Fix"],
          closingData.solution
        );
      }
    }
    if (!solutionFilled) {
      throw new Error("Field Solusi tidak ditemukan atau tidak dapat diisi");
    }

    const savedBeforeDue = await this.clickSaveButton();
    if (!savedBeforeDue) {
      throw new Error("Gagal menyimpan perubahan tiket sebelum Set Due Date");
    }

    await this.driver.sleep(500);

    if (typeof this.setFutureDueDate === "function") {
      try {
        await this.setFutureDueDate({
          explicitDate: closingData.dueDate,
          minOffsetDays: closingData.dueInDays || 1,
        });
      } catch (e) {
        logger.warn("setFutureDueDate gagal, melewati penyesuaian due date", {
          message: e.message,
        });
      }
    } else {
      logger.warn("setFutureDueDate belum diimplementasikan, melewati due date");
    }

    const savedAfterDue = await this.clickSaveButton();
    if (!savedAfterDue) {
      throw new Error("Gagal menyimpan tiket setelah Set Due Date");
    }

    const doneClicked = await this.clickDoneButton();
    if (!doneClicked) {
      throw new Error("Tombol Done tidak ditemukan");
    }

    await this.driver.sleep(1000);
    return true;
  }

  async setFutureDueDate() {
    // Buka dialog Set Due Date dan langsung klik Save/Simpan.
    // Logika perhitungan tanggal future dibiarkan ke Koprol (wizard default).
    await this.dismissAnyModal(2000);

    const clicked = await this.clickSetDueDateButton();
    if (!clicked) {
      throw new Error("Tombol Set Due Date tidak ditemukan");
    }

    try {
      await this.driver
        .wait(until.elementLocated(By.css(".modal-content")), 5000)
        .catch(() => {});
    } catch (e) {}

    let modal;
    try {
      modal = await this.getLatestModal();
    } catch (e) {
      throw new Error("Dialog Set Due Date tidak muncul");
    }

    let saved = false;
    for (const label of ["Save", "Simpan"]) {
      if (saved) break;
      try {
        await this.clickButtonInModal(modal, label);
        saved = true;
        break;
      } catch (e) {}
    }

    if (!saved) {
      throw new Error("Tombol Save pada dialog Set Due Date tidak ditemukan");
    }

    try {
      await this.driver.wait(until.stalenessOf(modal), 5000);
    } catch (e) {}
    await this.driver.sleep(400);
  }

  async ensureRequestFormListReady() {
    const directUrl = `${config.koprol.url}/web#model=eps.request.form&view_type=list`;

    // helper wait for renderer
    const waitList = async (timeout = 15000) => {
      try {
        await this.driver.wait(
          until.elementLocated(
            By.css("table.o_list_table, .o_list_renderer, .o_list_view")
          ),
          timeout
        );
        return true;
      } catch (e) {
        return false;
      }
    };

    // 1) Preferred: go directly to Request Form list via generic model URL (single quick attempt)
    for (let attempt = 0; attempt < 1; attempt++) {
      try {
        logger.info(
          `Opening Request Form list via direct URL (attempt ${
            attempt + 1
          }): ${directUrl}`
        );
        await this.driver.get(directUrl);
        await this.waitForPageReady();
        const listReady =
          (await this.isRequestFormListVisible()) || (await waitList());
        if (listReady) {
          return true;
        }
      } catch (e) {
        logger.warn("Direct URL Request Form load failed", {
          url: directUrl,
          message: e.message,
        });
      }
    }

    // 2) Fallback: use app switcher + JRF/ARF menu
    try {
      logger.warn(
        "Direct URL path to Request Form failed, falling back to app switcher/menu navigation"
      );
      await this.openRequestFormApp();
      await this.waitForUrlContains("model=eps.request.form", 12000);
      await this.waitForPageReady();
      if ((await this.isRequestFormListVisible()) || (await waitList(12000))) {
        return true;
      }

      await this.selectJrfMenuOption("Request Form");
      await this.waitForPageReady();
      if ((await this.isRequestFormListVisible()) || (await waitList(12000))) {
        return true;
      }
    } catch (e) {
      logger.warn("Fallback navigation to Request Form list failed", {
        message: e.message,
      });
    }

    // Instead of throwing, log warning and try to proceed anyway
    // The page might be usable even if list detection failed
    logger.warn(
      "Could not confirm Request Form list view, attempting to proceed anyway"
    );
    return true;
  }

  async clearRequestFormFacets() {
    try {
      const cp = await this.driver.findElement(
        By.xpath(
          "//div[contains(@class,'o_control_panel')][.//ol[contains(@class,'breadcrumb')]//li[contains(normalize-space(.), 'Request Form')]]"
        )
      );
      const removes = await cp.findElements(
        By.css(".o_searchview .o_facet_remove")
      );
      for (const rm of removes) {
        try {
          await rm.click();
          await this.driver.sleep(200);
        } catch (e) {}
      }
      const rff = await cp.findElements(
        By.xpath(
          ".//div[contains(@class,'o_searchview_facet')][.//*[contains(normalize-space(.), 'Request Form Final')]]//i[contains(@class,'o_facet_remove')]"
        )
      );
      for (const x of rff) {
        try {
          await x.click();
          await this.driver.sleep(200);
        } catch (e) {}
      }
    } catch (e) {
      logger.warn("No search facets to clear");
    }
    await this.driver.sleep(300);
  }

  async applyNomorTicketFilter(ticketIdentifier) {
    const searchInput = await this.getSearchInputForTitle("Request Form");
    try {
      await this.scrollIntoView(searchInput);
    } catch (e) {}
    let clickedSug = false;
    for (let i = 0; i < 3 && !clickedSug; i++) {
      await searchInput.click();
      await this.driver.sleep(150);
      await searchInput.clear().catch(() => {});
      await searchInput.sendKeys(ticketIdentifier);
      await this.driver.sleep(700);
      clickedSug = await this.pickSearchSuggestion(
        ["Search Nomor Ticket for", "Search Nomor Ticket Detail for"],
        ticketIdentifier,
        7000,
        true
      );
    }
    if (!clickedSug) {
      throw new Error('Suggestion "Nomor Ticket" tidak muncul di list view');
    }
    await this.driver.sleep(1300);
  }

  async openTicketFormFromList(ticketIdentifier) {
    await this.ensureRequestFormListReady();
    await this.clearRequestFormFacets();
    await this.applyNomorTicketFilter(ticketIdentifier);
    await this.openListRowAndWaitForm(ticketIdentifier);
  }

  async getFieldValueByLabel(labelText) {
    try {
      const widget = await this.driver.findElement(
        By.xpath(
          `//label[contains(@class,'o_form_label')][contains(normalize-space(.), '${labelText}')]/following::div[contains(@class,'o_field_widget')][1]`
        )
      );
      const text = await widget.getText();
      return text.trim();
    } catch (e) {
      return "";
    }
  }

  async getTicketDescriptionText() {
    // 1) Prefer explicit field widgets by technical name (more reliable than label text)
    const nameSelectors = [
      "span.o_field_widget[name='keterangan']",
      "span.o_field_widget[name='description']",
      "div.o_field_widget[name='keterangan']",
      "div.o_field_widget[name='description']",
    ];
    for (const sel of nameSelectors) {
      try {
        const el = await this.driver.findElement(By.css(sel));
        const txt = ((await el.getText()) || "").trim();
        if (txt) return txt;
      } catch (e) {}
    }

    // 2) Fallback to label-based lookup
    const labels = [
      "Deskripsi",
      "Description",
      "Keterangan",
      "Detail Request",
      "Detail",
      "Problem Description",
    ];
    for (const label of labels) {
      try {
        const val = await this.getFieldValueByLabel(label);
        if (val) return val;
      } catch (e) {}
    }
    return "";
  }

  async getLatestModal() {
    const modals = await this.driver.findElements(By.css(".modal-content"));
    if (!modals.length)
      throw new Error("Modal not found after opening request line");
    return modals[modals.length - 1];
  }

  async findVisibleInputs(scope, labelText = "") {
    const candidates = await scope.findElements(By.css("textarea, input"));
    for (const cand of candidates) {
      try {
        const ro = (await cand.getAttribute("readonly")) || "";
        const dis = (await cand.getAttribute("disabled")) || "";
        if (ro || dis) continue;
        const display = (await cand.getCssValue("display")) || "";
        const visibility = (await cand.getCssValue("visibility")) || "";
        const opacity = parseFloat((await cand.getCssValue("opacity")) || "1");
        const rect = await cand.getRect();
        if (
          display === "none" ||
          visibility === "hidden" ||
          opacity === 0 ||
          rect.height < 2 ||
          rect.width < 2
        ) {
          continue;
        }
        return cand;
      } catch (e) {}
    }
    return null;
  }

  async clickButtonInModal(modal, containsText) {
    let btn = null;
    try {
      btn = await modal.findElement(
        By.xpath(`.//button[contains(normalize-space(.), '${containsText}')]`)
      );
    } catch (e) {}

    if (!btn) {
      const xp = `//div[contains(@class,'modal') or contains(@class,'o_dialog_container')]//button[contains(normalize-space(.), '${containsText}')]`;
      const all = await this.driver.findElements(By.xpath(xp));
      if (all.length) {
        btn = all[all.length - 1];
      }
    }

    if (!btn) {
      throw new Error(`Button with text ${containsText} not found in modal`);
    }

    await btn.click();
    await this.driver.sleep(400);
  }

  async fillTextFieldByLabel(modal, labelText, value) {
    if (!value) return;

    let widget = null;
    // Primary: label + o_field_widget (standard Odoo form)
    try {
      widget = await modal.findElement(
        By.xpath(
          `.//label[contains(@class,'o_form_label')][contains(normalize-space(.), '${labelText}')]/following::div[contains(@class,'o_field_widget')][1]`
        )
      );
    } catch (e) {}

    // Fallback: table-based layout inside modal (td/th/span as label)
    if (!widget) {
      const labelCandidates = await modal.findElements(
        By.xpath(
          `.//*[self::label or self::td or self::th or self::span][contains(normalize-space(.), '${labelText}')]`
        )
      );
      if (labelCandidates.length) {
        const labelEl = labelCandidates[0];
        const containerXPaths = [
          "ancestor::tr[1]/td[position()>1]",
          "parent::td/following-sibling::td[1]",
          "following::td[1]",
          'ancestor::div[contains(@class,"o_group") or contains(@class,"o_form_group")][1]',
        ];
        for (const xp of containerXPaths) {
          const els = await labelEl.findElements(By.xpath(xp));
          if (els.length) {
            widget = els[0];
            break;
          }
        }
        if (!widget) {
          widget = labelEl;
        }
      } else {
        throw new Error(`Label not found for ${labelText}`);
      }
    }

    const inputs = await widget.findElements(By.css("textarea, input"));
    if (!inputs.length) {
      throw new Error(`No text inputs found for label ${labelText}`);
    }
    let input = null;
    for (const cand of inputs) {
      try {
        const ro = (await cand.getAttribute("readonly")) || "";
        const dis = (await cand.getAttribute("disabled")) || "";
        if (ro || dis) continue;
        const display = (await cand.getCssValue("display")) || "";
        const visibility = (await cand.getCssValue("visibility")) || "";
        const opacity = parseFloat((await cand.getCssValue("opacity")) || "1");
        const rect = await cand.getRect();
        if (
          display === "none" ||
          visibility === "hidden" ||
          opacity === 0 ||
          rect.height < 2 ||
          rect.width < 2
        ) {
          continue;
        }
        input = cand;
        break;
      } catch (e) {}
    }
    if (!input) {
      // try visible elements globally with same name to avoid hidden duplicates
      const fallback = await this.findVisibleInputs(modal, labelText);
      if (fallback) input = fallback;
    }
    if (!input) input = inputs[0];
    await this.scrollIntoView(input);
    await input.click();
    await this.driver.sleep(100);
    await input.clear().catch(() => {});
    await input.sendKeys(value);
    await this.driver.sleep(200);
  }

  async fillTextFieldByName(modal, fieldName, value) {
    if (!value) return false;
    const selectors = [
      `textarea[name="${fieldName}"]`,
      `input[name="${fieldName}"]`,
    ];
    for (const sel of selectors) {
      const inputs = await modal.findElements(By.css(sel));
      if (!inputs.length) continue;
      const input = inputs[0];
      try {
        const ro = (await input.getAttribute("readonly")) || "";
        const dis = (await input.getAttribute("disabled")) || "";
        if (ro || dis) continue;
      } catch (e) {}

      await this.scrollIntoView(input);
      await input.click();
      await this.driver.sleep(100);
      await input.clear().catch(() => {});
      await input.sendKeys(value);
      await this.driver.sleep(200);
      return true;
    }
    return false;
  }

  async fillTextFieldByFieldNameAttr(
    scope,
    fieldNames = [],
    value,
    bannedRowKeywords = []
  ) {
    if (!value || !fieldNames.length) return false;
    const selectors = fieldNames.map(
      (fn) =>
        `[data-fieldname="${fn}"] textarea, [data-fieldname="${fn}"] input`
    );
    const elements = await scope.findElements(By.css(selectors.join(",")));
    for (const el of elements) {
      try {
        const ro = (await el.getAttribute("readonly")) || "";
        const dis = (await el.getAttribute("disabled")) || "";
        if (ro || dis) continue;
        const display = (await el.getCssValue("display")) || "";
        const visibility = (await el.getCssValue("visibility")) || "";
        const opacity = parseFloat((await el.getCssValue("opacity")) || "1");
        const rect = await el.getRect();
        if (
          display === "none" ||
          visibility === "hidden" ||
          opacity === 0 ||
          rect.height < 2 ||
          rect.width < 2
        ) {
          continue;
        }
        if (bannedRowKeywords.length) {
          const rows = await el.findElements(By.xpath("ancestor::tr[1]"));
          if (rows.length) {
            const rowText = ((await rows[0].getText()) || "").toLowerCase();
            if (
              bannedRowKeywords.some((k) => rowText.includes(k.toLowerCase()))
            ) {
              continue;
            }
          }
        }
      } catch (e) {}

      await this.scrollIntoView(el);
      await el.click();
      await this.driver.sleep(100);
      await el.clear().catch(() => {});
      await el.sendKeys(value);
      await this.driver.sleep(200);
      return true;
    }
    return false;
  }

  async fillFieldInTableRow(modal, labelText, value) {
    if (!value) return false;
    let row;
    try {
      row = await modal.findElement(
        By.xpath(
          `.//tr[.//*[self::td or self::th or self::label or self::span][contains(normalize-space(.), '${labelText}')]]`
        )
      );
    } catch (e) {
      return false;
    }

    let fieldCell = null;
    const cells = await row.findElements(
      By.xpath("./td[position()>1] | ./th[position()>1]")
    );
    if (cells.length) {
      fieldCell = cells[0];
    } else {
      fieldCell = row;
    }

    const inputs = await fieldCell.findElements(By.css("textarea, input"));
    if (!inputs.length) return false;
    const input = inputs[0];
    await this.scrollIntoView(input);
    await input.click();
    await this.driver.sleep(100);
    await input.clear().catch(() => {});
    await input.sendKeys(value);
    await this.driver.sleep(200);
    return true;
  }

  async fillTextFieldByNameCandidates(
    modal,
    fieldNames = [],
    value,
    bannedRowKeywords = []
  ) {
    for (const name of fieldNames) {
      const selectors = [`textarea[name="${name}"]`, `input[name="${name}"]`];
      for (const sel of selectors) {
        const inputs = await modal.findElements(By.css(sel));
        if (!inputs.length) continue;
        const input = inputs[0];
        try {
          const ro = (await input.getAttribute("readonly")) || "";
          const dis = (await input.getAttribute("disabled")) || "";
          if (ro || dis) continue;
          if (bannedRowKeywords.length) {
            const rows = await input.findElements(By.xpath("ancestor::tr[1]"));
            if (rows.length) {
              const rowText = ((await rows[0].getText()) || "").toLowerCase();
              if (
                bannedRowKeywords.some((k) => rowText.includes(k.toLowerCase()))
              ) {
                continue;
              }
            }
          }
        } catch (e) {}

        await this.scrollIntoView(input);
        await input.click();
        await this.driver.sleep(100);
        await input.clear().catch(() => {});
        await input.sendKeys(value);
        await this.driver.sleep(200);
        return true;
      }
    }
    return false;
  }

  async fillTextFieldByLooseLabel(modal, labelText, value) {
    if (!value) return false;
    const labelEls = await modal.findElements(
      By.xpath(
        `.//*[self::label or self::td or self::th or self::span][contains(normalize-space(.), '${labelText}')]`
      )
    );
    if (!labelEls.length) return false;
    const labelEl = labelEls[0];

    const containerXPaths = [
      "ancestor::tr[1]",
      'ancestor::div[contains(@class,"o_group") or contains(@class,"o_form_group")][1]',
      "parent::td/parent::tr",
    ];
    for (const xp of containerXPaths) {
      const candidates = await labelEl.findElements(
        By.xpath(`${xp}//textarea | ${xp}//input[@type="text" or not(@type)]`)
      );
      if (candidates.length) {
        const input = candidates[0];
        await this.scrollIntoView(input);
        await input.click();
        await this.driver.sleep(100);
        await input.clear().catch(() => {});
        await input.sendKeys(value);
        await this.driver.sleep(200);
        return true;
      }
    }

    // Last resort: nearest following textarea/input (non-select)
    const follow = await labelEl.findElements(
      By.xpath(
        `following::textarea[1] | following::input[@type="text" or not(@type)][1]`
      )
    );
    if (follow.length) {
      const input = follow[0];
      await this.scrollIntoView(input);
      await input.click();
      await this.driver.sleep(100);
      await input.clear().catch(() => {});
      await input.sendKeys(value);
      await this.driver.sleep(200);
      return true;
    }

    return false;
  }

  async fillFirstEmptyTextarea(modal, value, bannedRowKeywords = []) {
    if (!value) return false;
    const areas = await modal.findElements(By.css("textarea"));
    for (const ta of areas) {
      try {
        const ro = (await ta.getAttribute("readonly")) || "";
        const dis = (await ta.getAttribute("disabled")) || "";
        if (ro || dis) continue;
        if (bannedRowKeywords.length) {
          const rows = await ta.findElements(By.xpath("ancestor::tr[1]"));
          if (rows.length) {
            const rowText = ((await rows[0].getText()) || "").toLowerCase();
            if (
              bannedRowKeywords.some((k) => rowText.includes(k.toLowerCase()))
            ) {
              continue;
            }
          }
        }
      } catch (e) {}

      let current = "";
      try {
        current = (await ta.getAttribute("value")) || "";
      } catch (e) {}
      if (!current) {
        try {
          current = await ta.getText();
        } catch (e) {}
      }
      if (current && current.trim()) continue;

      try {
        await this.scrollIntoView(ta);
        await ta.click();
        await this.driver.sleep(100);
        await ta.clear().catch(() => {});
        await ta.sendKeys(value);
        await this.driver.sleep(200);
        return true;
      } catch (e) {}
    }
    return false;
  }

  async fillFirstEmptyTextInput(modal, value) {
    if (!value) return false;
    const inputs = await modal.findElements(
      By.css('input[type="text"], input:not([type])')
    );
    for (const input of inputs) {
      try {
        const typeAttr = (await input.getAttribute("type")) || "text";
        if (typeAttr === "hidden") continue;
        const ro = (await input.getAttribute("readonly")) || "";
        const dis = (await input.getAttribute("disabled")) || "";
        if (ro || dis) continue;
        // Skip inputs that clearly belong to dropdown rows like Teams, PIC, Impact, Urgency, Request, etc.
        const disqualifyLabels = [
          "Teams",
          "PIC",
          "Impact",
          "Urgency",
          "Request",
          "Tipe Request",
          "Masalah",
          "Category",
        ];
        const rows = await input.findElements(By.xpath("ancestor::tr[1]"));
        if (rows.length) {
          const rowText = (await rows[0].getText()) || "";
          const lowerRow = rowText.toLowerCase();
          if (
            disqualifyLabels.some((l) => lowerRow.includes(l.toLowerCase()))
          ) {
            continue;
          }
        }
      } catch (e) {}

      let current = "";
      try {
        current = (await input.getAttribute("value")) || "";
      } catch (e) {}
      if (!current) {
        try {
          current = await input.getText();
        } catch (e) {}
      }
      if (current && current.trim()) continue;

      try {
        await this.scrollIntoView(input);
        await input.click();
        await this.driver.sleep(100);
        await input.clear().catch(() => {});
        await input.sendKeys(value);
        await this.driver.sleep(200);
        return true;
      } catch (e) {}
    }
    return false;
  }

  async selectDropdownByLabel(modal, labelText, value) {
    if (!value) return;

    let widget = null;
    // Primary: label + o_field_widget
    try {
      widget = await modal.findElement(
        By.xpath(
          `.//label[contains(@class,'o_form_label')][contains(normalize-space(.), '${labelText}')]/following::div[contains(@class,'o_field_widget')][1]`
        )
      );
    } catch (e) {}

    if (!widget) {
      const labelCandidates = await modal.findElements(
        By.xpath(
          `.//*[self::label or self::td or self::th or self::span][contains(normalize-space(.), '${labelText}')]`
        )
      );
      if (labelCandidates.length) {
        const labelEl = labelCandidates[0];
        const containerXPaths = [
          "ancestor::tr[1]/td[position()>1]",
          "parent::td/following-sibling::td[1]",
          "following::td[1]",
          'ancestor::div[contains(@class,"o_group") or contains(@class,"o_form_group")][1]',
        ];
        for (const xp of containerXPaths) {
          const els = await labelEl.findElements(By.xpath(xp));
          if (els.length) {
            widget = els[0];
            break;
          }
        }
        if (!widget) {
          widget = labelEl;
        }
      } else {
        throw new Error(`Label not found for ${labelText}`);
      }
    }

    const selects = await widget.findElements(By.css("select"));
    if (selects.length) {
      const sel = selects[0];
      await this.scrollIntoView(sel);
      try {
        await sel.click();
      } catch (e) {}
      await this.driver.sleep(100);

      // Set option by visible text and fire change/input events so Odoo onchange (SLA/OLA) runs
      await this.driver.executeScript(
        "var sel=arguments[0], txt=(arguments[1]||'').toLowerCase();" +
          "for (var i=0;i<sel.options.length;i++){var o=sel.options[i];" +
          " if ((o.text||'').toLowerCase()===txt){sel.selectedIndex=i;break;}}" +
          "sel.dispatchEvent(new Event('change',{bubbles:true}));" +
          "sel.dispatchEvent(new Event('input',{bubbles:true}));",
        sel,
        value
      );

      await this.driver.sleep(250);
      return;
    }

    const inputs = await widget.findElements(By.css("input"));
    if (!inputs.length) {
      throw new Error(`No dropdown inputs found for label ${labelText}`);
    }
    const input = inputs[0];
    await input.click();
    await this.driver.sleep(150);
    await input.clear().catch(() => {});
    await input.sendKeys(value);
    await this.driver.sleep(400);

    const lower = value.toLowerCase();
    const optionXpath = `//ul[contains(@class,'ui-autocomplete') or contains(@class,'o-autocomplete') or contains(@class,'dropdown-menu')]//li[.//*[contains(translate(normalize-space(.),'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'${lower}')] or contains(translate(normalize-space(.),'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'${lower}')]`;
    const items = await this.driver.findElements(By.xpath(optionXpath));
    if (items.length) {
      await items[0].click();
    } else {
      await input.sendKeys(Key.RETURN);
    }
    await this.driver.sleep(300);
  }

  async selectDropdownInTableRow(modal, labelText, value) {
    if (!value) return false;
    let row;
    try {
      row = await modal.findElement(
        By.xpath(
          `.//tr[.//*[self::td or self::th or self::span][contains(normalize-space(.), '${labelText}')]]`
        )
      );
    } catch (e) {
      return false;
    }

    let fieldCell = null;
    const cells = await row.findElements(
      By.xpath("./td[position()>1] | ./th[position()>1]")
    );
    if (cells.length) {
      fieldCell = cells[0];
    } else {
      fieldCell = row;
    }

    const selects = await fieldCell.findElements(By.css("select"));
    if (selects.length) {
      const sel = selects[0];
      await this.scrollIntoView(sel);
      try {
        await sel.click();
      } catch (e) {}
      await this.driver.sleep(100);

      await this.driver.executeScript(
        "var sel=arguments[0], txt=(arguments[1]||'').toLowerCase();" +
          "for (var i=0;i<sel.options.length;i++){var o=sel.options[i];" +
          " if ((o.text||'').toLowerCase()===txt){sel.selectedIndex=i;break;}}" +
          "sel.dispatchEvent(new Event('change',{bubbles:true}));" +
          "sel.dispatchEvent(new Event('input',{bubbles:true}));",
        sel,
        value
      );

      await this.driver.sleep(250);
      return true;
    }

    const inputs = await fieldCell.findElements(By.css("input"));
    if (!inputs.length) return false;
    const input = inputs[0];
    await this.scrollIntoView(input);
    await input.click();
    await this.driver.sleep(150);
    await input.clear().catch(() => {});
    await input.sendKeys(value);
    await this.driver.sleep(400);

    const lower = value.toLowerCase();
    const optionXpath = `//ul[contains(@class,'ui-autocomplete') or contains(@class,'o-autocomplete') or contains(@class,'dropdown-menu')]//li[.//*[contains(translate(normalize-space(.),'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'${lower}')] or contains(translate(normalize-space(.),'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'${lower}')]`;
    const items = await this.driver.findElements(By.xpath(optionXpath));
    if (items.length) {
      await items[0].click();
    } else {
      await input.sendKeys(Key.RETURN);
    }
    await this.driver.sleep(300);
    return true;
  }

  async selectUrgencyDropdown(modal, value) {
    if (!value) return false;
    let row;
    try {
      row = await modal.findElement(
        By.xpath(
          ".//tr[.//label[contains(normalize-space(.), 'Urgency')] or .//td[contains(normalize-space(.), 'Urgency')]]"
        )
      );
    } catch (e) {
      return false;
    }

    // Autocomplete-style many2one: exactly mimic manual behaviour: type then Enter
    let input = null;
    const inputs = await row.findElements(
      By.css("input.o_input.ui-autocomplete-input, .o_input_dropdown input.o_input")
    );
    if (inputs.length) {
      input = inputs[0];
    }
    if (!input) return false;

    await this.scrollIntoView(input);
    try {
      await input.click();
    } catch (e) {}
    await this.driver.sleep(150);

    try {
      await input.clear().catch(() => {});
    } catch (e) {}
    await input.sendKeys(value);
    await this.driver.sleep(400);

    // Press Enter to confirm selection and trigger onchange (SLA/OLA)
    try {
      await input.sendKeys(Key.RETURN);
      await this.driver.sleep(400);
      return true;
    } catch (e) {
      return false;
    }
  }

  async safeFillTextFieldInModal(modal, labelCandidates, value) {
    if (!value) return false;
    // Try exact label mapping first
    for (const label of labelCandidates) {
      try {
        await this.fillTextFieldByLabel(modal, label, value);
        return true;
      } catch (e) {
        // continue
      }
    }
    // Then try loose label (row-based) to avoid hitting wrong field like Teams
    for (const label of labelCandidates) {
      const ok = await this.fillTextFieldByLooseLabel(modal, label, value);
      if (ok) return true;
    }
    return false;
  }

  async safeSelectDropdownInModal(modal, labelCandidates, value) {
    if (!value) return false;
    for (const label of labelCandidates) {
      try {
        await this.selectDropdownByLabel(modal, label, value);
        return true;
      } catch (e) {}
    }
    // Fallback: table-row based lookup (Assign dialog style)
    for (const label of labelCandidates) {
      try {
        const ok = await this.selectDropdownInTableRow(modal, label, value);
        if (ok) return true;
      } catch (e) {}
    }
    return false;
  }

  async openRequestDetailFromMenu() {
    // Try open dropdown JRF/ARF and choose Request Detail
    let opened = false;
    const menuTriggerXPaths = [
      "//nav//*[self::a or self::button][contains(@class,'dropdown') or contains(@class,'o_menu_entry')][contains(normalize-space(.), 'JRF/ARF')]",
      "//a[contains(@class,'dropdown-toggle')][contains(., 'JRF/ARF')]",
      "//button[contains(., 'JRF/ARF')]",
    ];
    for (const xp of menuTriggerXPaths) {
      const els = await this.driver.findElements(By.xpath(xp));
      if (els.length) {
        try {
          await els[0].click();
          await this.driver.sleep(200);
          opened = true;
          break;
        } catch (e) {}
      }
    }
    if (opened) {
      const itemX =
        "//a[normalize-space(.)='Request Detail' or contains(normalize-space(.), 'Request Detail')]";
      const items = await this.driver.findElements(By.xpath(itemX));
      if (items.length) {
        try {
          await items[0].click();
        } catch (e) {}
      }
    }
    if (!opened) {
      // Fallback direct URL
      await this.driver.get(
        `${config.koprol.url}/web#model=eps.request.form.line&view_type=kanban&menu_id=301`
      );
    }
    await this.waitForUrlContains("model=eps.request.form.line");
    await this.waitForPageReady();
    // Ensure kanban or list renderer is present
    await this.driver.wait(
      until.elementLocated(
        By.css(".o_kanban_renderer, table.o_list_table, .o_list_renderer")
      ),
      12000
    );
  }

  async getSearchInputForTitles(titles) {
    for (const t of titles) {
      try {
        return await this.getSearchInputForTitle(t);
      } catch (e) {}
    }
    throw new Error("Search input not found for titles: " + titles.join(", "));
  }

  async pickSearchSuggestion(
    priorityTexts,
    ticket,
    timeout = 7000,
    preferLast = true
  ) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      for (const label of priorityTexts) {
        const xp = `//ul[contains(@class,'ui-autocomplete') or contains(@class,'o-autocomplete') or contains(@class,'dropdown-menu')]//li[.//*[contains(normalize-space(.), '${label}') and contains(normalize-space(.), '${ticket}')] or contains(normalize-space(.), '${label}') and contains(normalize-space(.), '${ticket}')]`;
        const items = await this.driver.findElements(By.xpath(xp));
        if (items.length) {
          try {
            const idx = preferLast ? items.length - 1 : 0;
            await items[idx].click();
            return true;
          } catch (e) {}
        }
      }
      // Generic catch-all: any suggestion that contains 'Nomor Ticket' and the ticket text
      const generic = await this.driver.findElements(
        By.xpath(
          `//ul[contains(@class,'ui-autocomplete') or contains(@class,'o-autocomplete') or contains(@class,'dropdown-menu')]//li[.//*[contains(translate(normalize-space(.),'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'nomor ticket') and contains(normalize-space(.), '${ticket}')] or contains(translate(normalize-space(.),'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'nomor ticket') and contains(normalize-space(.), '${ticket}')]`
        )
      );
      if (generic.length) {
        try {
          await generic[preferLast ? generic.length - 1 : 0].click();
          return true;
        } catch (e) {}
      }
      await this.driver.sleep(200);
    }
    return false;
  }

  async waitForFormView(timeout = 12000) {
    try {
      await this.driver.wait(
        until.elementLocated(
          By.css(".o_form_view, .o_form_renderer, .o_form_sheet")
        ),
        timeout
      );
      await this.driver.sleep(200);
      return true;
    } catch (e) {
      return false;
    }
  }

  async openListRowAndWaitForm(ticketIdentifier = null) {
    let row = null;
    if (ticketIdentifier) {
      const rowsByName = await this.driver.findElements(
        By.xpath(
          `//table[contains(@class,'o_list_table')]//tr[contains(@class,'o_data_row')][.//*[contains(normalize-space(.), '${ticketIdentifier}')]]`
        )
      );
      if (rowsByName.length) row = rowsByName[0];
    }
    if (!row) {
      row = await this.driver.findElement(
        By.css("table.o_list_table tbody tr.o_data_row")
      );
    }
    try {
      await this.driver
        .actions({ bridge: true })
        .move({ origin: row })
        .doubleClick()
        .perform();
    } catch (e) {
      await row.click();
      await this.driver.sleep(200);
      await this.driver
        .actions({ bridge: true })
        .sendKeys(Key.RETURN)
        .perform();
    }
    await this.waitForFormView();
  }

  async clickRfaButtonRobust() {
    // Try several selectors and wait until visible
    const xpathCandidates = [
      "//div[contains(@class,'o_form_statusbar')]//button[@name='action_rfa']",
      "//div[contains(@class,'o_form_statusbar')]//button[contains(translate(normalize-space(.),'abcdefghijklmnopqrstuvwxyz','ABCDEFGHIJKLMNOPQRSTUVWXYZ'),'RFA')]",
      "//button[@name='action_rfa']",
      "//button[contains(translate(normalize-space(.),'abcdefghijklmnopqrstuvwxyz','ABCDEFGHIJKLMNOPQRSTUVWXYZ'),'RFA')]",
      "//header//button[@name='action_rfa']",
      "//header//button//*[contains(translate(normalize-space(.),'abcdefghijklmnopqrstuvwxyz','ABCDEFGHIJKLMNOPQRSTUVWXYZ'),'RFA')]/ancestor::button[1]",
    ];
    let btn = null;
    for (const xp of xpathCandidates) {
      const found = await this.driver.findElements(By.xpath(xp));
      if (found.length) {
        btn = found[0];
        break;
      }
    }
    if (!btn) {
      // Ensure header is in view, then recheck
      try {
        await this.driver.executeScript("window.scrollTo(0,0);");
      } catch (e) {}
      await this.driver.sleep(200);
      for (const xp of xpathCandidates) {
        const found = await this.driver.findElements(By.xpath(xp));
        if (found.length) {
          btn = found[0];
          break;
        }
      }
    }
    if (!btn) {
      // Try action dropdown
      const clicked = await this.clickActionMenuItem([
        "RFA",
        "Request For Approval",
        "Request Approval",
        "Ajukan Approval",
        "Ajukan RFA",
        "Minta Persetujuan",
      ]);
      if (clicked) {
        await this.driver.sleep(1200);
        return;
      }
      throw new Error("RFA button not found on form");
    }
    try {
      try {
        await this.scrollIntoView(btn);
      } catch (e) {}
      await this.driver.wait(until.elementIsVisible(btn), 3000).catch(() => {});
      await btn.click();
    } catch (e1) {
      try {
        await this.driver.executeScript("arguments[0].click();", btn);
      } catch (e2) {
        throw e1;
      }
    }
    await this.driver.sleep(1200);
  }

  async clickActionMenuItem(labels) {
    let toggles = await this.driver.findElements(
      By.xpath(
        "//div[contains(@class,'o_form_statusbar')]//*[self::button or self::a][contains(@class,'dropdown') or contains(@data-toggle,'dropdown') or contains(@aria-haspopup,'true')]"
      )
    );
    // Also include explicit 'Action' button
    const actionBtns = await this.driver.findElements(
      By.xpath(
        "//div[contains(@class,'o_form_statusbar')]//button[normalize-space(.)='Action' or contains(normalize-space(.), 'Action')]"
      )
    );
    toggles = toggles.concat(actionBtns);
    for (const t of toggles) {
      try {
        await t.click();
        await this.driver.sleep(200);
      } catch (e) {}
      for (const l of labels) {
        const items = await this.driver.findElements(
          By.xpath(
            `//div[contains(@class,'dropdown-menu') and contains(@class,'show')]//a[normalize-space(.)='${l}' or contains(normalize-space(.), '${l}')]`
          )
        );
        if (items.length) {
          try {
            await items[0].click();
            return true;
          } catch (e) {}
        }
      }
    }
    return false;
  }

  async scrollIntoView(el) {
    try {
      await this.driver.executeScript(
        'arguments[0].scrollIntoView({block:"center", inline:"center"});',
        el
      );
    } catch (e) {}
    await this.driver.sleep(150);
  }

  async tryDragTicketToApproved(ticketIdentifier) {
    const draftGroup = await this.getKanbanGroup("Draft");
    const approvedGroup = await this.getKanbanGroup("Approved");
    if (!draftGroup || !approvedGroup) return false;
    const card = await this.driver.findElement(
      By.xpath(
        `//div[contains(@class,'o_kanban_group')][.//div[contains(@class,'o_kanban_header')]//*[contains(normalize-space(.), 'Draft')]]//div[contains(@class,'o_kanban_record')][.//*[contains(normalize-space(.), '${ticketIdentifier}')]]`
      )
    );
    const toCol = approvedGroup.drop || approvedGroup.group;

    await this.scrollIntoView(card);
    await this.scrollIntoView(toCol);

    // Attempt 1: press-move-release to target column
    try {
      await this.driver
        .actions({ bridge: true })
        .move({ origin: card })
        .press()
        .pause(200)
        .move({ origin: toCol, x: 30, y: 30 })
        .pause(300)
        .release()
        .perform();
    } catch (e) {}
    await this.driver.sleep(800);
    let moved = await this.waitForCardInColumn(
      "Approved",
      ticketIdentifier,
      1500
    );

    // Attempt 2: dragAndDrop fallback
    if (!moved) {
      try {
        await this.driver
          .actions({ bridge: true })
          .dragAndDrop(card, toCol)
          .perform();
      } catch (e) {}
      await this.driver.sleep(800);
      moved = await this.waitForCardInColumn(
        "Approved",
        ticketIdentifier,
        1500
      );
    }

    // Attempt 3: HTML5 drag & drop via JS events
    if (!moved) {
      try {
        const script = `
                  function h5DragDrop(src, tgt){
                    const dt = new DataTransfer();
                    const ev = (type, el)=>{
                      const e = new DragEvent(type, {bubbles:true, cancelable:true, dataTransfer: dt});
                      el.dispatchEvent(e);
                    };
                    ev('dragstart', src);
                    ev('dragenter', tgt);
                    ev('dragover', tgt);
                    ev('drop', tgt);
                    ev('dragend', src);
                  }
                  h5DragDrop(arguments[0], arguments[1]);
                `;
        await this.driver.executeScript(script, card, toCol);
      } catch (e) {}
      await this.driver.sleep(900);
      moved = await this.waitForCardInColumn(
        "Approved",
        ticketIdentifier,
        1500
      );
    }

    return moved;
  }

  async getKanbanGroup(title) {
    const group = await this.driver.findElements(
      By.xpath(
        `//div[contains(@class,'o_kanban_group')][.//div[contains(@class,'o_kanban_header')]//*[contains(normalize-space(.), '${title}')]]`
      )
    );
    if (!group.length) return null;
    let drop = null;
    try {
      drop = await group[0].findElement(By.css("div.o_kanban_records"));
    } catch (e) {}
    return { group: group[0], drop };
  }

  async waitForCardInColumn(columnTitle, ticketIdentifier, timeout = 3000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const found = await this.driver.findElements(
        By.xpath(
          `//div[contains(@class,'o_kanban_group')][.//div[contains(@class,'o_kanban_header')]//*[contains(normalize-space(.), '${columnTitle}')]]//div[contains(@class,'o_kanban_record')][.//*[contains(normalize-space(.), '${ticketIdentifier}')]]`
        )
      );
      if (found.length) return true;
      await this.driver.sleep(200);
    }
    return false;
  }

  async clickStatusbarStage(target = "Approved", waitMs = 5000) {
    // Try buttons/links within form statusbar which have stage labels
    const candidates = [
      target,
      "Approve",
      "Approved",
      "Approval",
      "Setujui",
      "Setuju",
    ];
    let els = [];
    for (const lab of candidates) {
      els = await this.driver.findElements(
        By.xpath(
          `//div[contains(@class,'o_form_statusbar')]//*[self::button or self::a or self::span][contains(normalize-space(.), '${lab}')]`
        )
      );
      if (els.length) break;
    }
    if (!els.length) return false;
    // Click the closest clickable element (button/a)
    let clickable = els[0];
    try {
      clickable = await els[0].findElement(By.xpath("ancestor::button[1]"));
    } catch (e) {
      try {
        clickable = await els[0].findElement(By.xpath("ancestor::a[1]"));
      } catch (e2) {}
    }
    try {
      await clickable.click();
    } catch (e) {
      return false;
    }
    const start = Date.now();
    while (Date.now() - start < waitMs) {
      const active = await this.driver.findElements(
        By.xpath(
          `//div[contains(@class,'o_form_statusbar')]//*[contains(normalize-space(.), '${target}')][contains(@class,'active') or contains(@class,'btn-primary') or @aria-pressed='true' or @aria-checked='true']`
        )
      );
      if (active.length) return true;
      await this.driver.sleep(200);
    }
    // Some views don't mark active; assume success if no error
    return true;
  }

  async openRequestFormApp() {
    // Open app switcher (grid button at top-left)
    const toggleSelectors = [
      "button.o_menu_toggle",
      "a.o_menu_toggle",
      ".o_navbar_apps",
      ".o_menu_apps",
    ];
    for (const sel of toggleSelectors) {
      const found = await this.driver.findElements(By.css(sel));
      if (found.length) {
        try {
          await found[0].click();
          await this.driver.sleep(400);
          break;
        } catch (e) {}
      }
    }

    // Wait app tiles
    try {
      await this.driver.wait(
        until.elementLocated(By.css("a.o_app, .o_app")),
        8000
      );
    } catch (e) {}

    // Click Request Form tile by text
    let clicked = false;
    const tileXPaths = [
      "//a[contains(@class,'o_app')][.//span[contains(., 'Request Form')] or contains(., 'Request Form')]",
      "//div[contains(@class,'o_app')][.//span[contains(., 'Request Form')] or contains(., 'Request Form')]",
      "//a[.//div[contains(., 'Request Form')] or .//span[contains(., 'Request Form')]]",
    ];
    for (const xp of tileXPaths) {
      const els = await this.driver.findElements(By.xpath(xp));
      if (els.length) {
        try {
          await els[0].click();
          clicked = true;
          break;
        } catch (e) {}
      }
    }

    if (!clicked) {
      // Fallback: go directly by generic model URL (without menu/action to avoid wrong apps)
      await this.driver.get(
        `${config.koprol.url}/web#model=eps.request.form&view_type=list`
      );
    }

    await this.waitForPageReady();

    // Ensure list/kanban content really loaded (not Discuss)
    try {
      await this.driver.wait(
        until.elementLocated(
          By.css(
            ".o_list_view, .o_list_renderer, table.o_list_table, .o_kanban_renderer"
          )
        ),
        20000
      );
    } catch (e) {
      logger.warn(
        "Timeout waiting for list/kanban renderer after openRequestFormApp, continuing anyway"
      );
    }
  }

  async openFirstRequestLineModalFromForm() {
    // Ensure Request tab is active
    try {
      const tab = await this.driver.findElement(
        By.xpath(
          "//div[contains(@class,'o_notebook')]//a[contains(@class,'nav-link')][.//span[normalize-space(.)='Request'] or normalize-space(.)='Request']"
        )
      );
      try {
        await tab.click();
        await this.driver.sleep(400);
      } catch (e) {}
    } catch (e) {}

    const rowXPaths = [
      "//div[contains(@class,'o_notebook')]//table[contains(@class,'o_list_table')]//tr[contains(@class,'o_data_row')]",
      "//div[contains(@class,'o_notebook')]//tbody/tr[contains(@class,'o_data_row')]",
    ];
    let row = null;
    for (const xp of rowXPaths) {
      const rows = await this.driver.findElements(By.xpath(xp));
      if (rows.length) {
        row = rows[0];
        break;
      }
    }
    if (!row) {
      throw new Error("Baris Request tidak ditemukan pada form tiket");
    }

    await this.scrollIntoView(row);
    try {
      await this.driver
        .actions({ bridge: true })
        .move({ origin: row })
        .doubleClick()
        .perform();
    } catch (e) {
      try {
        await row.click();
        await this.driver.sleep(200);
        await this.driver
          .actions({ bridge: true })
          .sendKeys(Key.RETURN)
          .perform();
      } catch (e2) {}
    }

    // Wait for Open: Request modal
    await this.driver
      .wait(until.elementLocated(By.css(".modal-content")), 8000)
      .catch(() => {});
    await this.driver.sleep(300);
  }

  async performAssignment(ticketIdentifier, assignment = {}) {
    logger.info(`Starting assignment for ticket: ${ticketIdentifier}`);

    // Ensure Open Request modal is open
    let modals = await this.driver.findElements(By.css(".modal-content"));
    if (!modals.length) {
      await this.openFirstRequestLineModalFromForm();
      modals = await this.driver.findElements(By.css(".modal-content"));
    }
    if (!modals.length) {
      throw new Error('Modal "Open: Request" tidak ditemukan sebelum Assign');
    }

    // Click Assign button inside Open: Request modal
    const openReqModal = await this.getLatestModal();
    let assignClicked = false;
    const assignXPaths = [
      ".//button[normalize-space(.)='Assign' or contains(normalize-space(.), 'Assign')]",
      ".//*[self::button or self::a][contains(normalize-space(.), 'Assign')]",
    ];
    for (const xp of assignXPaths) {
      const btns = await openReqModal.findElements(By.xpath(xp));
      if (btns.length) {
        try {
          await btns[0].click();
          assignClicked = true;
          break;
        } catch (e) {}
      }
    }
    if (!assignClicked) {
      throw new Error("Tombol Assign tidak ditemukan pada form Request");
    }

    // Wait for Assign modal to appear on top
    await this.driver
      .wait(until.elementLocated(By.css(".modal-content")), 8000)
      .catch(() => {});
    await this.driver.sleep(400);

    const modal = await this.getLatestModal();

    const description = await this.getTicketDescriptionText();
    const titleGuess = guessTitle(description || "");
    const noteGuess = guessHelpdeskNote(description || "");
    const bobotGuess = guessBobot(description || "");

    const bannedTextRowKeywords = [
      "teams",
      "team",
      "pic",
      "impact",
      "urgency",
      "request",
      "type request",
      "tipe request",
      "masalah",
      "category",
      "kategori",
      "master",
      "system",
      "sistem",
    ];

    let okNote = await this.fillTextFieldByFieldNameAttr(
      modal,
      ["keterangan_helpdesk"],
      noteGuess
    );
    if (!okNote) {
      okNote = await this.fillTextFieldByNameCandidates(
        modal,
        ["keterangan_helpdesk", "helpdesk_note", "helpdesk"],
        noteGuess,
        bannedTextRowKeywords
      );
    }
    if (!okNote) {
      okNote = await this.safeFillTextFieldInModal(
        modal,
        ["Keterangan Helpdesk", "Helpdesk Note"],
        noteGuess
      );
    }

    // Odoo often re-renders the modal after typing into Keterangan Helpdesk.
    // Refresh modal reference to avoid stale element issues for subsequent fields.
    await this.driver.sleep(300);
    let modalAfterNote = modal;
    try {
      modalAfterNote = await this.getLatestModal();
    } catch (e) {}

    const okTitle = await this.fillTitleFieldInAssignModal(
      modalAfterNote,
      titleGuess
    );
    const okTeams = await this.safeSelectDropdownInModal(
      modalAfterNote,
      ["Teams", "Team"],
      "IT HELPDESK SS"
    );
    let okBobot = false;
    try {
      okBobot = await this.selectBobotDropdown(modalAfterNote, bobotGuess);
    } catch (e) {}
    if (!okBobot) {
      okBobot = await this.safeSelectDropdownInModal(
        modalAfterNote,
        ["Bobot", "Difficulty"],
        bobotGuess
      );
    }

    const okPic = assignment.pic
      ? await this.safeSelectDropdownInModal(
          modalAfterNote,
          ["PIC", "PIC Helpdesk"],
          assignment.pic
        )
      : false;
    const okImpact = assignment.impact
      ? await this.safeSelectDropdownInModal(
          modalAfterNote,
          ["Impact"],
          assignment.impact
        )
      : false;

    let okUrgency = false;
    if (assignment.urgency) {
      // Prefer explicit Urgency dropdown helper that clicks the o_dropdown_button
      okUrgency = await this.selectUrgencyDropdown(
        modalAfterNote,
        assignment.urgency
      );
      if (!okUrgency) {
        okUrgency = await this.safeSelectDropdownInModal(
          modalAfterNote,
          ["Urgency", "Urgensi"],
          assignment.urgency
        );
      }
    }

    // Nudge Urgency to ensure SLA/OLA onchange is triggered in Odoo
    if (okUrgency && assignment.urgency) {
      try {
        const current = (assignment.urgency || "").toLowerCase();
        let alt = "Medium";
        if (current === "medium") alt = "High";
        else if (current === "high") alt = "Low";

        // Toggle to alternate value then back to requested one, using the same dropdown UI
        await this.selectUrgencyDropdown(modalAfterNote, alt);
        await this.driver.sleep(300);
        await this.selectUrgencyDropdown(modalAfterNote, assignment.urgency);
        await this.driver.sleep(500);
      } catch (e) {
        logger.warn("Failed to toggle urgency to trigger SLA/OLA", {
          message: e.message,
        });
      }
    }

    if (!okNote) {
      const byPh = await this.fillTextareaByPlaceholder(
        modal,
        ["keterangan", "helpdesk", "note", "deskripsi", "description"],
        noteGuess
      );
      if (byPh) okNote = true;
    }
    if (!okNote) {
      const fbNote = await this.fillFirstEmptyTextarea(
        modal,
        noteGuess,
        bannedTextRowKeywords
      );
      if (fbNote) okNote = true;
    }

    logger.info("Assignment modal fill status", {
      note: okNote,
      title: okTitle,
      teams: okTeams,
      bobot: okBobot,
      pic: okPic,
      impact: okImpact,
      urgency: okUrgency,
    });

    let saved = false;
    for (const label of ["Save", "Simpan", "OK"]) {
      try {
        await this.clickButtonInModal(modalAfterNote, label);
        saved = true;
        break;
      } catch (e) {}
    }
    if (!saved) {
      logger.warn(
        "Save button for assignment modal not found; assignment may not be applied"
      );
    }

    let started = false;
    if (saved) {
      try {
        await this.driver.wait(async () => {
          const modalsAfter = await this.driver.findElements(
            By.css(".modal-content")
          );
          return modalsAfter.length === 0;
        }, 5000);
      } catch (e) {}

      started = await this.clickStartButtonRobust();
      if (!started) {
        logger.warn(
          "Start button not found after assignment; ticket may not be started automatically"
        );
      }
    } else {
      logger.warn("Skip Start because assignment modal was not saved");
    }

    return { saved, started };
  }

  async claimTicket(ticketIdentifier, assignment = null) {
    try {
      let assignmentAttempted = false;
      let assignmentCompleted = false;
      let assignmentError = null;

      if (this.driver) {
        try {
          await this.driver.quit();
        } catch (e) {
          logger.warn("Failed to close old driver:", e.message);
        }
        this.driver = null;
        this.isLoggedIn = false;
      }

      await this.initialize();
      await this.login();

      logger.info(`Attempting to RFA ticket: ${ticketIdentifier}`);

      // 1) Open Request Form via app switcher and ensure content isn't Discuss
      logger.info("Opening Request Form (list view) via app switcher");
      await this.ensureRequestFormListReady();

      // 2) Clear any active search facets/templates
      try {
        const cp = await this.driver.findElement(
          By.xpath(
            "//div[contains(@class,'o_control_panel')][.//ol[contains(@class,'breadcrumb')]//li[contains(normalize-space(.), 'Request Form')]]"
          )
        );
        const removes = await cp.findElements(
          By.css(".o_searchview .o_facet_remove")
        );
        for (const rm of removes) {
          try {
            await rm.click();
            await this.driver.sleep(200);
          } catch (e) {}
        }
        // Ensure specific favorite 'Request Form Final' is cleared
        const rff = await cp.findElements(
          By.xpath(
            ".//div[contains(@class,'o_searchview_facet')][.//*[contains(normalize-space(.), 'Request Form Final')]]//i[contains(@class,'o_facet_remove')]"
          )
        );
        for (const x of rff) {
          try {
            await x.click();
            await this.driver.sleep(200);
          } catch (e) {}
        }
      } catch (e) {
        logger.warn("No search facets to clear");
      }
      await this.driver.sleep(300);

      // 3) Preferred path: LIST VIEW ONLY (clear favorites, pick 'Nomor Ticket for', open row)
      let opened = false;
      try {
        logger.info(
          'Searching in Request Form list view using "Nomor Ticket for"'
        );
        const searchInput = await this.getSearchInputForTitle("Request Form");
        try {
          await this.scrollIntoView(searchInput);
        } catch (e) {}
        let clickedSug = false;
        for (let i = 0; i < 3 && !clickedSug; i++) {
          await searchInput.click();
          await this.driver.sleep(150);
          await searchInput.clear().catch(() => {});
          await searchInput.sendKeys(ticketIdentifier);
          await this.driver.sleep(700);
          clickedSug = await this.pickSearchSuggestion(
            ["Search Nomor Ticket for", "Search Nomor Ticket Detail for"],
            ticketIdentifier,
            7000,
            true
          );
        }
        if (!clickedSug)
          throw new Error(
            'Suggestion "Nomor Ticket" tidak muncul di list view'
          );
        await this.driver.sleep(1300);

        // Open the single result row
        await this.openListRowAndWaitForm(ticketIdentifier);
        opened = true;
      } catch (e) {
        logger.warn(
          "List search path failed, fallback to Request Detail (kanban)",
          { message: e.message }
        );
      }

      // No kanban fallback per user preference

      // Ensure we are on form view before attempting RFA
      await this.waitForFormView();
      logger.info(`Ticket ${ticketIdentifier} opened, clicking RFA`);
      await this.clickRfaButtonRobust();
      logger.info(`Successfully clicked RFA for ticket: ${ticketIdentifier}`);

      let startedAfterAssign = false;
      if (assignment && Object.keys(assignment).length) {
        assignmentAttempted = true;
        try {
          const assignResult = await this.performAssignment(
            ticketIdentifier,
            assignment
          );
          assignmentCompleted = !!(assignResult && assignResult.saved);
          startedAfterAssign = !!(assignResult && assignResult.started);
          if (assignmentCompleted) {
            logger.info(
              `Successfully assigned ticket: ${ticketIdentifier} (saved=${assignResult.saved}, started=${assignResult.started})`
            );
          } else {
            logger.warn(
              `Assignment for ticket ${ticketIdentifier} did not save correctly`
            );
          }
        } catch (e) {
          assignmentError = e;
          logger.error(`Assignment failed for ticket ${ticketIdentifier}`, e);
        }
      }

      if (assignmentAttempted && !assignmentCompleted) {
        return {
          success: false,
          message: `⚠️ Tiket "${ticketIdentifier}" sudah di-RFA, tetapi gagal assign di Koprol.\n⚠️ Error: ${
            assignmentError ? assignmentError.message : "Unknown error"
          }`,
          ticketId: ticketIdentifier,
        };
      }

      let msg;
      if (assignmentCompleted && startedAfterAssign) {
        msg = `✅ Tiket "${ticketIdentifier}" berhasil di-RFA dan di-assign!\n🚀 Ticket sudah di-Start untuk Teams IT HELPDESK SS`;
      } else if (assignmentCompleted && !startedAfterAssign) {
        msg = `✅ Tiket "${ticketIdentifier}" berhasil di-RFA dan di-assign!\n⚠️ Namun ticket *BELUM* di-Start otomatis. Mohon cek dan Start manual di Koprol.`;
      } else {
        msg = `✅ Tiket "${ticketIdentifier}" berhasil di-RFA!\n📤 Status: Moved to Approved column\n⏱️ Waiting for approval`;
      }

      return {
        success: true,
        assigned: !!assignmentCompleted,
        started: !!startedAfterAssign,
        message: msg,
        ticketId: ticketIdentifier,
      };
    } catch (error) {
      logger.error(`Failed to RFA/assign ticket: ${ticketIdentifier}`, error);

      return {
        success: false,
        message: `❌ Gagal memproses tiket "${ticketIdentifier}" (RFA/assign)\n⚠️ Error: ${error.message}\n\n💡 Pastikan tiket ada di kolom Draft`,
        ticketId: ticketIdentifier,
      };
    }
  }

  async close() {
    if (this.driver) {
      await this.driver.quit();
      this.driver = null;
      this.isLoggedIn = false;
      logger.info("WebDriver closed");
    }
  }
}

module.exports = KoprolAutomation;
