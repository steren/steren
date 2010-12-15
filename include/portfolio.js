/**
 * Copyright 2010 Steren Giannini steren.giannini@gmail.com
 * This script is licensed under GPLv3: modify it as long as you attribute and share it
 */

/** two dimentional array containing current state (types[group][type]) */
var types = [];

function filterClick(input) {
	// Get the group and type of the button clicked
	var groupAndType = input.target.id;
	groupAndType = groupAndType.split(':');
	var type = groupAndType[1];
	var typeGroup = groupAndType[0];

	// Change the value
	if (types[typeGroup][type] == 0) {
		types[typeGroup][type] = 1;
		$(input.target).addClass('active');
	} else {
		types[typeGroup][type] = 0; 
		$(input.target).removeClass('active');
	};

	refresh();
}

function show($element) {
	$element.removeClass('hidden');
}

function hide($element) {
	$element.addClass('hidden');
}

function refresh() {
	$(".work").each( function(i, work) {
		var classes = work.className;
		classes = classes.split(' ');
		
		var resultArray = [];

		for(j=0; j<classes.length; j++) {
			groupAndType = classes[j].split(':');
			// only consider the group and type classes
			if(groupAndType[1] != null) {
				type = groupAndType[1];
				typeGroup = groupAndType[0];

				if( resultArray[typeGroup] != null ) {
					resultArray[typeGroup] += types[typeGroup][type];
				} else {
					resultArray[typeGroup] = types[typeGroup][type];
				}
			}
		}

		var result = 1;
		for( val in resultArray ) {
			result *= resultArray[val];
		}

		if(result == 0) {
			hide($(work));
		} else {
			show($(work));
		}

	});
}

$(document).ready(function() {

	// Populate types
	$(".filter").each( function(i, filter) {
		var groupAndType = filter.id.split(':');
		
		var type = groupAndType[1];
		var typeGroup = groupAndType[0];
		
		var value = $(filter).hasClass("active") ? 1 : 0;
		
		if(types[typeGroup] == null) {
			var group = [];
			group[type] = value;
			types[typeGroup] = group;
		} else {
			types[typeGroup][type]= value;
		}
	});
	
	refresh();
	
	// Attach 'filterClick' to filters
	$(".filter").click(filterClick);

});
