var types = [];
var inputs;

var works;

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

function refresh() {
	$(".work").each( function(i, work) {
		var classes = work.className;
		classes = classes.split(' ');
		
		var resultArray = [];

		for(j=1; j<classes.length; j++) {
			groupAndType = classes[j].split(':');
			type = groupAndType[1];
			typeGroup = groupAndType[0];

			if( resultArray[typeGroup] != null ) {
				resultArray[typeGroup] += types[typeGroup][type];
			} else {
				resultArray[typeGroup] = types[typeGroup][type];
			}
		}

		var result = 1;
		for( val in resultArray ) {
			result *= resultArray[val];
		}

		if(result == 0) {
			$(work).hide('normal');
		} else {
			$(work).show('normal');
		}

	});
}

$(document).ready(function() {

	// Populate types
	$(".filter").each( function(i, filter) {
		var groupAndType = filter.id;
		groupAndType = groupAndType.split(':');
		var type = groupAndType[1];
		var typeGroup = groupAndType[0];
		types[typeGroup];
		if(types[typeGroup] == null) {
			group = [];
			group[type] = 1;
			types[typeGroup] = group;
		} else {
			types[typeGroup][type]= 1;
		}
	});
	
	// Attach 'refresh' to filters
	inputs = $(".filter");
	inputs.click(filterClick);

});
