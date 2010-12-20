/**
 * Copyright 2010 Steren Giannini steren.giannini@gmail.com
 * This script is licensed under GPLv3: modify it as long as you attribute and share it
 */

/** The Work template */
var workTemplate = 	['<div data-id="{{id}}" class="work seriousness:{{seriousness}} type:{{type}} participation:{{participation}}">',
					'<p class="title">{{title}}</p>',
					'<p class="category">{{category}}</p>',
					'<p class="date">{{date}}</p>',
					'<p class="description">{{description}}</p>',
					'{{#links}}',
						'<p class="link"><a href="{{href}}">{{value}}</a></p>',
					'{{/links}}',
					'</div>'].join('');

/** two dimentional array containing current state (types[group][type]) */
var types = [];

/** data are sorted by */
var sortBy = 'date';

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

function sortClick(input) {
	$(".sort").removeClass('active');
	$(input.target).addClass('active');
	sortBy = input.target.id;
	refresh();
}

function refresh() {
	// sort depending on the sort option selected
	sortData();
	
	$('#worksTarget').html('');
	// iterate on every work
	for( var i =0; i < data.length; i++ ) {
		var work = data[i];
		// this array will contain the resutl value for every filter group
		var resultArray = [];

		// for each filter group
		for( var j = 0; j < filterGroups.length; j++ ) {
				var typeGroup = filterGroups[j];
				var type = work[typeGroup];
			
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
		
		if(result != 0) {
			var html = Mustache.to_html(workTemplate, work);
			$('#worksTarget').append(html);
		}
	}
	
	$('#works').quicksand( $('#worksTarget div'), {useScaling: true});
}

function sortData() {
	data.sort(function(a, b) {
		reversed = true;
		var valA = a[sortBy];
		var valB = b[sortBy];
		if (reversed) {
		  return (valA < valB) ? 1 : (valA > valB) ? -1 : 0;				
		} else {		
		  return (valA < valB) ? -1 : (valA > valB) ? 1 : 0;	
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
	
	// generate all works	
	for(i in data) {
		var html = Mustache.to_html(workTemplate, data[i]);
		$('#works').append(html);
	}

	$(".filter").click(filterClick);
	$(".sort").click(sortClick);

	// refresh to take into account the filters initial values
	refresh();
	
});

