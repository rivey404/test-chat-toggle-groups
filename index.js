import { extension_settings, getContext } from "../../../extensions.js";
import { oai_settings, setupChatCompletionPromptManager } from "../../../openai.js";
import { POPUP_TYPE, callGenericPopup } from "../../../popup.js";
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';
import { ARGUMENT_TYPE, SlashCommandArgument, SlashCommandNamedArgument } from '../../../slash-commands/SlashCommandArgument.js';
import {
    eventSource,
    event_types,
    saveSettingsDebounced,
} from "../../../../script.js";

const extensionName = "chat-toggle-groups";
const extensionFolderPath = `scripts/extensions/third-party/${extensionName}`;
let extensionSettings = extension_settings[extensionName];
const defaultSettings = {
    version: "1.0.0",
    presets: {},
    disableAnimation: true, // Add this new setting
};

const escapeString = (str) => str.replace(/[&<>"']/g, match => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;',
})[match]);

let groupLookupMap = {}; // For fast group lookup by name
let $toggleGroupsContainer; // Cache the container reference

// Add this helper function at the top level to help with debugging
function logCurrentGroups() {
    const currentPreset = oai_settings.preset_settings_openai;
    const groups = extensionSettings.presets[currentPreset] || [];
    console.log(`Current preset: ${currentPreset}`);
    console.log(`Groups for current preset:`, groups);
    return groups;
}

jQuery(async () => {
    await loadSettings();
    const toggleMenu = await $.get(`${extensionFolderPath}/toggle-menu.html`);
    $('.range-block.m-b-1').before(toggleMenu);
    
    // Initialize container reference AFTER adding the toggle menu to the DOM
    $toggleGroupsContainer = $('.toggle-groups');
    
    console.log('Toggle groups container found:', $toggleGroupsContainer.length);
    console.log('Add toggle group button found:', $('.add-toggle-group').length);
    
    // Make sure event handlers are attached properly
    $('.add-toggle-group').off('click').on('click', function() {
        console.log('Add toggle group button clicked');
        onAddGroupClick();
    });
    
    // Load groups for the current preset and log results
    const loadedGroups = loadGroupsForCurrentPreset();
    console.log('Loaded groups count:', loadedGroups ? loadedGroups.length : 0);
    
    // Always attach event handlers, even if no groups are loaded
    attachGroupEventListeners();

    eventSource.on(event_types.OAI_PRESET_EXPORT_READY, (preset) => {
        const currentPreset = oai_settings.preset_settings_openai;

        // Check if there's data for the current preset
        if (extensionSettings.presets[currentPreset]) {
            // Add the linked toggle groups data and version to the preset
            preset.linkedToggleGroups = {
                version: extensionSettings.version,
                groups: extensionSettings.presets[currentPreset]
            };
        }
    });

    eventSource.on(event_types.OAI_PRESET_IMPORT_READY, (importedPreset) => {
        if (importedPreset.data.linkedToggleGroups) {
            const importedData = importedPreset.data.linkedToggleGroups;

            // Check the version of the imported data

            // Update the extension settings with the imported data
            extensionSettings.presets[importedPreset.presetName] = importedData.groups;

            // Save the updated settings
            saveSettings();

            // Reload the groups for the current preset
            loadGroupsForCurrentPreset();
        }
    });

    const $disableAnimationCheckbox = $('#disable-animation-checkbox');
    $disableAnimationCheckbox.prop('checked', extensionSettings.disableAnimation);

    // Add event listener for the "Disable Animation" checkbox
    $('#disable-animation-checkbox').on('change', () => {
        extensionSettings.disableAnimation = $('#disable-animation-checkbox').is(':checked');
        saveSettings();
    });

    // Add event listener for preset changes
    eventSource.on(event_types.OAI_PRESET_CHANGED_AFTER, () => {
        loadGroupsForCurrentPreset();
    });
});

async function loadSettings() {
    // Initialize extension_settings[extensionName] with default settings if it doesn't exist
    if (!extension_settings[extensionName]) {
        extension_settings[extensionName] = Object.assign({}, defaultSettings);
    }

    // Assign extensionSettings for easier access
    extensionSettings = extension_settings[extensionName];

    // Ensure all default settings are present
    for (const [key, value] of Object.entries(defaultSettings)) {
        if (!extensionSettings.hasOwnProperty(key)) {
            extensionSettings[key] = value;
        }
    }

    // Load the drawer template
    const drawerTemplate = await $.get(`${extensionFolderPath}/drawer-template.html`);
    // Store the template in the extension settings for later use
    extensionSettings.drawerTemplate = drawerTemplate;

    // Load the toggle item template
    const toggleItemTemplate = await $.get(`${extensionFolderPath}/toggle-item-template.html`);
    // Store the template in the extension settings for later use
    extensionSettings.toggleItemTemplate = toggleItemTemplate;
    
    // Remove container initialization from here since toggle-groups doesn't exist yet
}

function loadGroups(groups) {
    // Reset the lookup map
    groupLookupMap = {};
    
    $toggleGroupsContainer.empty(); // Use cached reference

    groups.forEach((group, index) => {
        const $groupElement = $(extensionSettings.drawerTemplate.replace('{{GROUP_NAME}}', escapeString(group.name)));
        const $toggleList = $groupElement.find('.toggle-list');
        const $toggleAction = $groupElement.find('.linked-toggle-group-action');

        // Set initial toggle state
        if (group.isOn) {
            $toggleAction.removeClass('fa-toggle-off').addClass('fa-toggle-on');
        } else {
            $toggleAction.removeClass('fa-toggle-on').addClass('fa-toggle-off');
        }

        group.toggles.forEach(toggle => {
            const $toggleItem = $(extensionSettings.toggleItemTemplate);
            populateTargetSelect($toggleItem.find('.toggle-target')); // Populate target options first
            $toggleItem.find('.toggle-target').val(toggle.target); // Then set the saved target
            $toggleItem.find('.toggle-behavior').val(toggle.behavior);
            $toggleItem.attr('data-target', toggle.target); // Add data-target attribute
            $toggleList.append($toggleItem);
        });

        $toggleGroupsContainer.append($groupElement);

        // Add to lookup map for faster access
        groupLookupMap[group.name] = {
            data: group,
            index: index,
            element: $groupElement
        };
    });

    console.log(`Loaded ${groups.length} toggle groups`);
    console.log(`Toggle groups container found: ${$toggleGroupsContainer.length > 0}`);
    console.log(`Groups lookup map has ${Object.keys(groupLookupMap).length} entries`);
}

function addToggle($group, groupName) {
    const $toggleList = $group.find('.toggle-list');
    const $newToggle = $(extensionSettings.toggleItemTemplate);

    // Populate the target select with available options
    populateTargetSelect($newToggle.find('.toggle-target'));

    $toggleList.append($newToggle);

    // Update the settings using the lookup map instead of finding the group each time
    const currentPreset = oai_settings.preset_settings_openai;
    const groupInfo = groupLookupMap[groupName];
    
    if (groupInfo && groupInfo.data) {
        groupInfo.data.toggles.push({
            target: '',
            behavior: 'direct' // Set default behavior
        });
        saveSettings();
    } else {
        console.error(`Group "${groupName}" not found in lookup map when adding toggle.`);
        
        // Fallback to the old method if lookup map fails
        const groups = extensionSettings.presets[currentPreset];
        const group = groups.find(g => g.name === groupName);
        if (group) {
            group.toggles.push({
                target: '',
                behavior: 'direct'
            });
            saveSettings();
        }
    }
}

function populateTargetSelect($select) {
    const promptManager = setupChatCompletionPromptManager(oai_settings);
    const prompts = promptManager.serviceSettings.prompts;

    $select.empty(); // Clear existing options
    $select.append($('<option>', {
        value: '',
        text: 'Select a target',
        disabled: true,
        hidden: true,
        selected: true
    }));

    prompts.forEach(prompt => {
        $select.append($('<option>', {
            value: prompt.identifier,
            text: prompt.name,
            'data-identifier': prompt.identifier
        }));
    });
}

function attachGroupEventListeners() {
    console.log('Attaching group event listeners');
    
    // Always use document-level delegation for dynamically added elements
    $(document).off('click', '.toggle-groups .add-toggle').on('click', '.toggle-groups .add-toggle', function() {
        console.log('Add toggle button clicked');
        const $group = $(this).closest('.toggle-group');
        const groupName = $group.find('.group-name').text();
        console.log('Adding toggle to group:', groupName);
        addToggle($group, groupName);
    });
    
    // Use more specific delegation for other handlers
    if (!extensionSettings.eventHandlersAttached) {
        // Use document-level delegation for all other handlers too
        $(document).on("click", ".toggle-groups .linked-toggle-group-action", function(e) {
            e.stopPropagation();
            const $toggle = $(this);
            const $group = $toggle.closest('.toggle-group');
            const groupName = $group.find('.group-name').text();

            $toggle.toggleClass('fa-toggle-off fa-toggle-on');

            const isOn = $toggle.hasClass('fa-toggle-on');
            updateGroupState(groupName, isOn);
        });

        // ...existing code for other handlers but replace $toggleGroups with $(document)...
        // For example:
        $(document).on("click", ".toggle-groups .linked-toggle-group-edit", function(e) {
            e.stopPropagation();
            const $group = $(this).closest('.toggle-group');
            const groupName = $group.find('.group-name').text();
            editGroupName($group, groupName);
        });

        // ...and so on for other handlers...
        
        extensionSettings.eventHandlersAttached = true;
    }
}

function updateToggleSettings($group) {
    const groupName = $group.find('.group-name').text();
    const currentPreset = oai_settings.preset_settings_openai;
    const groups = extensionSettings.presets[currentPreset];
    const group = groups.find(g => g.name === groupName);

    if (group) {
        group.toggles = [];
        $group.find('.toggle-item').each(function() {
            const $item = $(this);
            group.toggles.push({
                target: $item.find('.toggle-target').val(),
                behavior: $item.find('.toggle-behavior').val()
            });
        });
        saveSettings();
    }
}

function moveGroup($group, direction) {
    const $groups = $('.toggle-group');
    const index = $groups.index($group);
    const currentPreset = oai_settings.preset_settings_openai;
    const groups = extensionSettings.presets[currentPreset];

    if (direction === 'up' && index > 0) {
        // Cache the DOM elements
        const $prevGroup = $groups.eq(index - 1);
        
        // Update DOM directly
        $group.insertBefore($prevGroup);
        
        // Update data array
        const temp = groups[index];
        groups[index] = groups[index - 1];
        groups[index - 1] = temp;
        
        // Update lookup map indices
        updateLookupMapIndices();
    } else if (direction === 'down' && index < $groups.length - 1) {
        // Similar optimization for moving down
        const $nextGroup = $groups.eq(index + 1);
        
        // Update DOM directly
        $group.insertAfter($nextGroup);
        
        // Update data array
        const temp = groups[index];
        groups[index] = groups[index + 1];
        groups[index + 1] = temp;
        
        // Update lookup map indices
        updateLookupMapIndices();
    }

    saveSettings();
}

// Add this helper function
function updateLookupMapIndices() {
    const $groups = $('.toggle-group');
    $groups.each((index, element) => {
        const groupName = $(element).find('.group-name').text();
        if (groupLookupMap[groupName]) {
            groupLookupMap[groupName].index = index;
        }
    });
}

function updateGroupState(groupName, isOn) {
    const currentPreset = oai_settings.preset_settings_openai;
    if (!extensionSettings.presets[currentPreset]) {
        extensionSettings.presets[currentPreset] = [];
    }
    const groups = extensionSettings.presets[currentPreset];
    
    // Use lookup map instead of findIndex
    const groupInfo = groupLookupMap[groupName];
    if (groupInfo) {
        groupInfo.data.isOn = isOn;
        saveSettings();

        // Apply the toggle state to all targets in the group
        const promptManager = setupChatCompletionPromptManager(oai_settings);
        groupInfo.data.toggles.forEach(toggle => {
            applyToggleBehavior(promptManager, toggle, isOn);
        });

        // Update the UI and save the service settings after all toggles have been processed
        promptManager.render();
        promptManager.saveServiceSettings();

        console.log(`Group "${groupName}" is now ${isOn ? 'on' : 'off'}`);
    } else {
        console.error(`Group "${groupName}" not found in the current preset.`);
    }
}

function applyToggleBehavior(promptManager, toggle, isGroupOn) {
    const promptOrderEntry = promptManager.getPromptOrderEntry(promptManager.activeCharacter, toggle.target);
    const counts = promptManager.tokenHandler.getCounts();

    if (!promptOrderEntry) {
        console.error(`Prompt order entry not found for target: ${toggle.target}`);
        return;
    }

    switch (toggle.behavior) {
        case 'direct':
            promptOrderEntry.enabled = isGroupOn;
            break;
        case 'invert':
            promptOrderEntry.enabled = !isGroupOn;
            break;
        case 'toggle':
            promptOrderEntry.enabled = !promptOrderEntry.enabled;
            break;
        case 'random':
            promptOrderEntry.enabled = Math.random() < 0.5;
            break;
        default:
            console.error(`Unknown toggle behavior: ${toggle.behavior}`);
    }

    // Reset the token count for the affected prompt
    counts[toggle.target] = null;

    // Check if animation should be disabled
    if (extensionSettings.disableAnimation) {
        return; // Skip the animation
    }

    // Find the toggle item element based on data-target attribute
    const $toggleItem = $(`.toggle-item[data-target="${toggle.target}"]`);

    // Reset the colors before applying the new state
    $toggleItem.css({
        'background-color': '',
        'color': '',
        'opacity': ''
    });

    if (promptOrderEntry.enabled) {
        $toggleItem.addClass('enabled').removeClass('disabled');
    } else {
        $toggleItem.addClass('disabled').removeClass('enabled');
    }

    clearTimeout(toggle.fadeOutTimeout); // Clear any previously scheduled timeout
    toggle.fadeOutTimeout = setTimeout(() => {
        requestAnimationFrame(() => {
            $toggleItem.addClass('fade-out');
            setTimeout(() => {
                $toggleItem.removeClass('fade-out');
                if (!promptOrderEntry.enabled) {
                    $toggleItem.css('opacity', 1.0);
                }
            }, 300);
        });
    }, 1000);
}

async function editGroupName($group, currentName) {
    const newName = await callGenericPopup("Enter a name for the new group:", POPUP_TYPE.INPUT, currentName);
    if (newName && newName !== currentName) {
        if (groupNameExists(newName)) {
            toastr.warning(`Group "${newName}" already exists!"`);
            return;
        }
        const $groupName = $group.find('.group-name');
        $groupName.text(newName);

        // Update the group name in the settings
        const currentPreset = oai_settings.preset_settings_openai;
        const groups = extensionSettings.presets[currentPreset];
        const groupIndex = groups.findIndex(g => g.name === currentName);
        if (groupIndex !== -1) {
            groups[groupIndex].name = newName;
            saveSettings();
        }
    }
}

function deleteGroup($group, groupName) {
    const currentPreset = oai_settings.preset_settings_openai;
    if (extensionSettings.presets[currentPreset]) {
        extensionSettings.presets[currentPreset] = extensionSettings.presets[currentPreset].filter(g => g.name !== groupName);
        saveSettings();
    }
    $group.remove();
}

// Also improve the create group dialog function to be more robust
async function onAddGroupClick() {
    console.log('Add Group click handler executed');
    
    try {
        const groupName = await callGenericPopup("Enter a name for the new group:", POPUP_TYPE.INPUT, '');
        console.log('Group name entered:', groupName);
        
        if (!groupName) {
            console.log('No group name provided or dialog canceled');
            return;
        }
        
        if (groupNameExists(groupName)) {
            toastr.warning(`Group "${groupName}" already exists!"`);
            return;
        }
        
        console.log('Creating new group:', groupName);
        
        const newGroup = {
            name: groupName,
            toggles: [],
            isOn: false
        };

        const currentPreset = oai_settings.preset_settings_openai;
        
        // Initialize the presets object and current preset if needed
        if (!extensionSettings.presets) {
            extensionSettings.presets = {};
        }
        
        if (!extensionSettings.presets[currentPreset]) {
            extensionSettings.presets[currentPreset] = [];
        }
        
        const groups = extensionSettings.presets[currentPreset];
        groups.push(newGroup);

        console.log('Group added to settings, creating UI element');
        
        const $groupElement = $(extensionSettings.drawerTemplate.replace('{{GROUP_NAME}}', groupName));
        
        // Always get a fresh reference to the container to avoid stale references
        const $container = $('.toggle-groups');
        $container.append($groupElement);
        
        // Update the lookup map with the new group
        groupLookupMap[groupName] = {
            data: newGroup,
            index: groups.length - 1,
            element: $groupElement
        };

        // Save the updated settings
        saveSettings();
        
        // Ensure event handlers are attached to the new group
        attachGroupEventListeners();
        
        console.log('New group created successfully:', groupName);
    } catch (error) {
        console.error('Error creating new group:', error);
    }
}

function saveSettings() {
    // Save the extension settings
    extension_settings[extensionName] = extensionSettings;
    saveSettingsDebounced();
}

function groupNameExists(groupName) {
    const currentPreset = oai_settings.preset_settings_openai;
    const groups = extensionSettings.presets[currentPreset] || [];
    const groupNameLower = groupName.toLowerCase();

    return groups.some(group => group.name.toLowerCase() === groupNameLower);
}

SlashCommandParser.addCommandObject(SlashCommand.fromProps({
    name: 'toggle-group',
    callback: (namedArgs, unnamedArgs) => {
        const searchString = unnamedArgs.toString();
        const targetState = namedArgs.state ?? 'toggle';
        toggleGroupsByString(searchString, targetState);
    },
    aliases: ['tg'],
    // returns: 'void',
    namedArgumentList: [
        SlashCommandNamedArgument.fromProps({
            name: 'state',
            description: 'the target state for the group',
            typeList: ARGUMENT_TYPE.STRING,
            defaultValue: 'toggle',
            enumList: ['on', 'off', 'toggle'],
        }),
    ],
    unnamedArgumentList: [
        SlashCommandArgument.fromProps({
            description: 'the string of the group name',
            typeList: ARGUMENT_TYPE.STRING,
            isRequired: true,
        }),
    ],
    helpString: `
        <div>
            Toggles the state of a group named with the provided string.
        </div>
        <div>
            <strong>Example:</strong>
            <ul>
                <li>
                    <pre><code class="language-stscript">/toggle-groups example</code></pre>
                    toggles the state of group named "example"
                </li>
                <li>
                    <pre><code class="language-stscript">/tg state=on test</code></pre>
                    turns on group named "test"
                </li>
                <li>
                    <pre><code class="language-stscript">/tg state=off foo</code></pre>
                    turns off group named "foo"
                </li>
            </ul>
        </div>
    `,
}));

function toggleGroupsByString(searchString, targetState) {
    const currentPreset = oai_settings.preset_settings_openai;
    const groups = extensionSettings.presets[currentPreset] || [];
    const searchStringLower = searchString.toLowerCase();
    let foundGroups = false;

    const $toggleGroups = $('.toggle-groups');

    for (const group of groups) {
        if (group.name.toLowerCase() === searchStringLower) {
            foundGroups = true;
            const isOn = targetState === 'toggle' ? !group.isOn : targetState === 'on';
            updateGroupState(group.name, isOn);

            const $group = $toggleGroups.find(`.toggle-group .group-name:contains(${escapeString(group.name)})`).closest('.toggle-group');
            const $toggleAction = $group.find('.linked-toggle-group-action');

            if (isOn) {
                $toggleAction.removeClass('fa-toggle-off').addClass('fa-toggle-on');
            } else {
                $toggleAction.removeClass('fa-toggle-on').addClass('fa-toggle-off');
            }
            break; // Exit the loop early since a match was found
        }
    }

    if (!foundGroups) {
        toastr.warning(`No groups found containing "${searchString}".`);
    }
}
